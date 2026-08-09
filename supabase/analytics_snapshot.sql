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
-- OJO con cómo está escrita: la primera versión usaba subqueries correlacionadas
-- para armar byHour y las líneas de cada parada, o sea que se ejecutaban 500
-- veces (una por parada) y cada una recorría entera la CTE de horas. Medido:
-- 33,8s para 7 días, peor que agregar en JavaScript. Todo lo de acá abajo está
-- escrito para que cada CTE se recorra UNA vez: los conteos por hora salen
-- pivoteados con FILTER en un solo group by, las líneas con un group by sobre
-- la ventana, y el ensamblado final es un join, no una correlación.
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
cur  as (select * from base where es_curr),
prev as (select * from base where not es_curr),

-- Todos los escalares del período actual en UNA sola pasada.
tot as (
    select
        count(*)::int                                                        as total,
        count(distinct client_hash)::int                                     as clientes,
        (count(*) filter (where cache_status = 'HIT'))::int                  as hit,
        (count(*) filter (where cache_status = 'MISS'))::int                 as miss,
        (count(*) filter (where cache_status = 'STALE'))::int                as stale,
        (count(*) filter (where cache_status not in ('HIT','MISS','STALE')))::int as unknown,
        percentile_cont(0.5)  within group (order by duration_ms)            as p50,
        percentile_cont(0.95) within group (order by duration_ms)            as p95,
        count(duration_ms)::int                                              as muestras
    from cur
),

p_top as (
    select codigo_parada as key, count(*)::int as cnt
    from cur where codigo_parada is not null
    group by 1 order by 2 desc limit 500
),
-- byHour pivoteado con FILTER: un group by, 24 contadores, una sola pasada.
p_arr as (
    select
        c.codigo_parada as key,
        count(*)::int as cnt,
        jsonb_build_array(
            (count(*) filter (where c.hora = 0))::int,  (count(*) filter (where c.hora = 1))::int,
            (count(*) filter (where c.hora = 2))::int,  (count(*) filter (where c.hora = 3))::int,
            (count(*) filter (where c.hora = 4))::int,  (count(*) filter (where c.hora = 5))::int,
            (count(*) filter (where c.hora = 6))::int,  (count(*) filter (where c.hora = 7))::int,
            (count(*) filter (where c.hora = 8))::int,  (count(*) filter (where c.hora = 9))::int,
            (count(*) filter (where c.hora = 10))::int, (count(*) filter (where c.hora = 11))::int,
            (count(*) filter (where c.hora = 12))::int, (count(*) filter (where c.hora = 13))::int,
            (count(*) filter (where c.hora = 14))::int, (count(*) filter (where c.hora = 15))::int,
            (count(*) filter (where c.hora = 16))::int, (count(*) filter (where c.hora = 17))::int,
            (count(*) filter (where c.hora = 18))::int, (count(*) filter (where c.hora = 19))::int,
            (count(*) filter (where c.hora = 20))::int, (count(*) filter (where c.hora = 21))::int,
            (count(*) filter (where c.hora = 22))::int, (count(*) filter (where c.hora = 23))::int
        ) as byhour
    from cur c
    join p_top t on t.key = c.codigo_parada
    group by 1
),
p_lin_rank as (
    select key, linea, cnt, row_number() over (partition by key order by cnt desc) as rn
    from (
        select c.codigo_parada as key, c.linea, count(*)::int as cnt
        from cur c
        join p_top t on t.key = c.codigo_parada
        where c.linea is not null
        group by 1, 2
    ) x
),
p_lin3 as (
    select key,
           jsonb_agg(jsonb_build_object('linea', linea, 'count', cnt) order by cnt desc) as lineas
    from p_lin_rank where rn <= 3
    group by key
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
prev_p as (
    select codigo_parada as key, count(*)::int as cnt
    from prev where codigo_parada is not null group by 1
),
prev_l as (
    select linea as key, count(*)::int as cnt
    from prev where linea is not null group by 1
)
select jsonb_build_object(
    'total',     (select total from tot),
    'prevTotal', (select count(*)::int from prev),
    'clientes',  (select clientes from tot),
    'cache', (select jsonb_build_object('hit', hit, 'miss', miss, 'stale', stale, 'unknown', unknown) from tot),
    'latencia', (select jsonb_build_object('p50', p50, 'p95', p95, 'muestras', muestras) from tot),
    'heatmap', coalesce((
        select jsonb_agg(jsonb_build_object('hour', hora, 'dow', dow, 'count', cnt)) from heat
    ), '[]'::jsonb),
    -- join, no correlación: p_arr y p_lin3 ya vienen agregados por parada
    'paradas', coalesce((
        select jsonb_agg(jsonb_build_object(
            'key', a.key, 'count', a.cnt, 'byHour', a.byhour,
            'lineas', coalesce(l.lineas, '[]'::jsonb)
        ) order by a.cnt desc)
        from p_arr a left join p_lin3 l on l.key = a.key
    ), '[]'::jsonb),
    'lineas', coalesce((
        select jsonb_agg(jsonb_build_object('key', key, 'count', cnt) order by cnt desc) from l_top
    ), '[]'::jsonb),
    'ramales', coalesce((
        select jsonb_agg(jsonb_build_object('key', key, 'count', cnt) order by cnt desc) from r_top
    ), '[]'::jsonb),
    'prevParadas', coalesce((select jsonb_object_agg(key, cnt) from prev_p), '{}'::jsonb),
    'prevLineas',  coalesce((select jsonb_object_agg(key, cnt) from prev_l), '{}'::jsonb)
);
$$;
