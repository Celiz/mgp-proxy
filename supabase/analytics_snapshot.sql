-- Agregación del snapshot de analytics adentro de Postgres.
--
-- Por qué: getAnalyticsSnapshot() bajaba TODOS los eventos crudos al proxy y los
-- agregaba en JavaScript. Con 113.506 eventos de arribos eso son ~11 MB por
-- consulta, y el proxy corre en un teléfono. Medido contra producción antes de
-- esto: 1 día 4,5s · 7 días 11,2s · 30 días 21,2s.
--
-- Los índices ya estaban bien (idx_query_events_accion_ts cubre el filtro), así
-- que el costo no era buscar sino transferir. Esta función devuelve el mismo
-- agregado en unos pocos KB.
--
-- Sobre agrupar por codigo_parada: el proxy canonicaliza los ids de parada con
-- un mapa estático (Codigo -> Identificador). Verificado que acá no hace falta
-- replicarlo: los Codigo que aliasean van de 15010 a 74362 y los numéricos que
-- aparecen en query_events son 1 y 10002-10055, sin un solo solapamiento. Si
-- alguna vez empiezan a entrar códigos del rango 15010-74362, esta agrupación
-- deja de coincidir con la del proxy y hay que subir el mapa de alias a una
-- tabla (mismo patrón que parada_geo).
--
-- Zona horaria: hora 0-23 y dow domingo=0, igual que partsInAR() en el proxy.

create or replace function analytics_snapshot(
    p_days     int,
    p_linea    text    default null,
    p_con_prev boolean default false
)
returns jsonb
language sql
stable
as $$
with lim as (
    select
        now() - make_interval(days => p_days) as desde_curr,
        case when p_con_prev
             then now() - make_interval(days => p_days * 2)
             else now() - make_interval(days => p_days)
        end as desde_total
),
base as (
    select
        e.codigo_parada,
        e.linea,
        e.ramal,
        e.client_hash,
        upper(coalesce(e.cache_status, '')) as cache_status,
        e.duration_ms,
        extract(hour from e.ts at time zone 'America/Argentina/Buenos_Aires')::int as hora,
        extract(dow  from e.ts at time zone 'America/Argentina/Buenos_Aires')::int as dow,
        (e.ts >= l.desde_curr) as es_curr
    from query_events e
    cross join lim l
    where e.accion = 'RecuperarProximosArribosW'
      and e.ts >= l.desde_total
      and (p_linea is null or e.linea = p_linea)
),
cur as (select * from base where es_curr),
prev as (select * from base where not es_curr),

-- Top paradas del período actual. El resto de los agregados por parada se
-- calculan sólo para estas, que son las únicas que el dashboard muestra.
p_top as (
    select codigo_parada as key, count(*)::int as cnt
    from cur where codigo_parada is not null
    group by 1 order by 2 desc limit 500
),
p_hora as (
    select c.codigo_parada as key, c.hora, count(*)::int as cnt
    from cur c join p_top t on t.key = c.codigo_parada
    group by 1, 2
),
p_lin as (
    select key, linea, cnt,
           row_number() over (partition by key order by cnt desc) as rn
    from (
        select c.codigo_parada as key, c.linea, count(*)::int as cnt
        from cur c join p_top t on t.key = c.codigo_parada
        where c.linea is not null
        group by 1, 2
    ) x
),
l_top as (
    select linea as key, count(*)::int as cnt
    from cur where linea is not null
    group by 1 order by 2 desc limit 50
),
r_top as (
    select (linea || ' · ' || ramal) as key, count(*)::int as cnt
    from cur where linea is not null and ramal is not null
    group by 1 order by 2 desc limit 15
),
heat as (
    select hora, dow, count(*)::int as cnt
    from cur group by 1, 2
),
-- Período anterior: sólo lo que hace falta para los deltas.
prev_p as (
    select codigo_parada as key, count(*)::int as cnt
    from prev where codigo_parada is not null group by 1
),
prev_l as (
    select linea as key, count(*)::int as cnt
    from prev where linea is not null group by 1
)
select jsonb_build_object(
    'total', (select count(*) from cur),
    'prevTotal', (select count(*) from prev),
    'clientes', (select count(distinct client_hash) from cur where client_hash is not null),
    'cache', jsonb_build_object(
        'hit',     (select count(*) from cur where cache_status = 'HIT'),
        'miss',    (select count(*) from cur where cache_status = 'MISS'),
        'stale',   (select count(*) from cur where cache_status = 'STALE'),
        'unknown', (select count(*) from cur where cache_status not in ('HIT','MISS','STALE'))
    ),
    'latencia', jsonb_build_object(
        'p50', (select percentile_cont(0.5) within group (order by duration_ms)
                from cur where duration_ms is not null),
        'p95', (select percentile_cont(0.95) within group (order by duration_ms)
                from cur where duration_ms is not null),
        'muestras', (select count(*) from cur where duration_ms is not null)
    ),
    'heatmap', coalesce((
        select jsonb_agg(jsonb_build_object('hour', hora, 'dow', dow, 'count', cnt))
        from heat), '[]'::jsonb),
    'paradas', coalesce((
        select jsonb_agg(jsonb_build_object(
            'key',   t.key,
            'count', t.cnt,
            -- 24 posiciones siempre, con 0 en las horas sin datos
            'byHour', (
                select jsonb_agg(coalesce(h.cnt, 0) order by g.i)
                from generate_series(0, 23) g(i)
                left join p_hora h on h.key = t.key and h.hora = g.i
            ),
            'lineas', coalesce((
                select jsonb_agg(jsonb_build_object('linea', l.linea, 'count', l.cnt)
                                 order by l.cnt desc)
                from p_lin l where l.key = t.key and l.rn <= 3
            ), '[]'::jsonb)
        ) order by t.cnt desc)
        from p_top t), '[]'::jsonb),
    'lineas', coalesce((
        select jsonb_agg(jsonb_build_object('key', key, 'count', cnt) order by cnt desc)
        from l_top), '[]'::jsonb),
    'ramales', coalesce((
        select jsonb_agg(jsonb_build_object('key', key, 'count', cnt) order by cnt desc)
        from r_top), '[]'::jsonb),
    'prevParadas', coalesce((
        select jsonb_object_agg(key, cnt) from prev_p), '{}'::jsonb),
    'prevLineas', coalesce((
        select jsonb_object_agg(key, cnt) from prev_l), '{}'::jsonb)
);
$$;
