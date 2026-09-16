/* Ruas e afinidades de recursos obtidas do OpenStreetMap. */
const ROAD_TYPES = 'primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|path|steps|cycleway|track|primary_link|secondary_link|tertiary_link';
const ZOMBIE_HABITAT = { tags: { amenity: ['hospital', 'clinic', 'doctors', 'grave_yard'], healthcare: ['hospital', 'clinic', 'doctor'], landuse: ['cemetery'] } };
const RESOURCE_HABITATS = [
    { types: ['wood'], label: 'Madeira', places: 'Parques, praças, jardins e florestas', tags: { leisure: ['park', 'garden'], landuse: ['forest', 'orchard'], natural: ['wood', 'tree'], place: ['square'] } },
    { types: ['water'], label: 'Água', places: 'Lagos, rios, córregos, reservatórios e fontes', tags: { natural: ['water', 'spring'], waterway: ['river', 'stream', 'canal'], landuse: ['reservoir'], amenity: ['drinking_water', 'fountain'] } },
    { types: ['food'], label: 'Enlatados', places: 'Supermercados e lojas de conveniência', tags: { shop: ['supermarket', 'convenience'] } },
    { types: ['fresh_food'], label: 'Alimentos frescos', places: 'Feiras, hortifrútis, hortas, pomares e fazendas', tags: { shop: ['greengrocer', 'supermarket'], amenity: ['marketplace'], landuse: ['allotments', 'orchard', 'farmland'] } },
    { types: ['scrap'], label: 'Sucata', places: 'Áreas industriais, oficinas, obras e ferros-velhos', tags: { landuse: ['industrial', 'construction'], shop: ['car_repair', 'hardware'], amenity: ['recycling'] } },
    { types: ['medkit'], label: 'Kit médico', places: 'Hospitais, clínicas, farmácias e postos de saúde', tags: { amenity: ['hospital', 'clinic', 'pharmacy', 'doctors'], healthcare: ['hospital', 'clinic', 'pharmacy', 'doctor'] } },
    { types: ['battery_resource', 'battery_zombie'], label: 'Baterias', places: 'Lojas de eletrônicos, oficinas e postos de combustível', tags: { shop: ['electronics', 'electrical', 'car_repair'], amenity: ['fuel'] } }
];
const ROAD_WORLD = { nodes: new Map(), segments: [], habitats: [], hazards: [], rawElements: [], center: null, loading: false, attempted: 0, distances: new Map(), routeTime: 0 };

function habitatMatches(tags, habitat) {
    return Object.entries(habitat.tags).some(([key, values]) => values.includes(tags[key]));
}
function renderResourceLegend() {
    document.getElementById('resource-legend').innerHTML = '<h3>Onde encontrar mais recursos</h3><p>Procure nas ruas e caminhos próximos a estes locais. A chance aumenta até 120 m; os itens não são garantidos.</p>' +
        RESOURCE_HABITATS.map(h => `<div class="resource-legend-row"><b><i class="fa-solid ${ITEMS_DB[h.types[0]].icon}" aria-hidden="true"></i> ${h.label}</b><span>${h.places}</span></div>`).join('') +
        '<p>Sem um local identificado por perto, os recursos têm a distribuição comum. Fabrique medicina, repelentes, kits de zona e armadilhas no Craft.</p>';
}
function roadInterpolate(a, b, t) { return L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t); }
function roadProjection(point, a, b) {
    const scale = Math.cos(point.lat * Math.PI / 180);
    const dx = (b.lng - a.lng) * scale, dy = b.lat - a.lat;
    const t = Math.max(0, Math.min(1, (((point.lng - a.lng) * scale) * dx + (point.lat - a.lat) * dy) / (dx * dx + dy * dy || 1)));
    return roadInterpolate(a, b, t);
}
function geometryDistance(point, geometry) {
    let distance = Infinity, inside = false;
    for (let i = 0; i < geometry.length; i++) {
        const a = geometry[i], b = geometry[(i + 1) % geometry.length];
        distance = Math.min(distance, getDistance(point, a));
        if (i + 1 < geometry.length) distance = Math.min(distance, getDistance(point, roadProjection(point, a, b)));
        if ((a.lat > point.lat) !== (b.lat > point.lat) && point.lng < (b.lng - a.lng) * (point.lat - a.lat) / (b.lat - a.lat) + a.lng) inside = !inside;
    }
    const closed = geometry.length > 3 && geometry[0].lat === geometry.at(-1).lat && geometry[0].lng === geometry.at(-1).lng;
    return closed && inside ? 0 : distance;
}
function buildRoadWorld(elements) {
    const nodes = new Map(), segments = [], habitats = [], hazards = [];
    function node(id, loc) { if (!nodes.has(id)) nodes.set(id, { id, loc, links: new Map() }); return nodes.get(id); }
    const allowed = new Set(ROAD_TYPES.split('|'));
    for (const element of elements) {
        const tags = element.tags || {};
        const geometry = (element.geometry || []).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)).map(p => L.latLng(p.lat, p.lon));
        if (element.type === 'way' && allowed.has(tags.highway) && tags.area !== 'yes' && !['private', 'no'].includes(tags.access) && tags.foot !== 'no') {
            for (let i = 1; i < geometry.length; i++) {
                const a = geometry[i - 1], b = geometry[i], length = getDistance(a, b);
                if (!length || length > 3000) continue;
                const count = Math.ceil(length / CONFIG.roadSegmentLength);
                let previous = node(`osm:${element.nodes[i - 1]}`, a);
                for (let j = 1; j <= count; j++) {
                    const id = j === count ? `osm:${element.nodes[i]}` : `way:${element.id}:${i}:${j}`;
                    const next = node(id, roadInterpolate(a, b, j / count));
                    const distance = getDistance(previous.loc, next.loc);
                    previous.links.set(next.id, distance); next.links.set(previous.id, distance);
                    segments.push({ a: previous, b: next, length: distance }); previous = next;
                }
            }
        }
        const matches = RESOURCE_HABITATS.filter(h => habitatMatches(tags, h));
        const dangerous = habitatMatches(tags, ZOMBIE_HABITAT);
        if (!matches.length && !dangerous) continue;
        const shapes = geometry.length ? [geometry] : element.type === 'node' ? [[L.latLng(element.lat, element.lon)]] :
            (element.members || []).filter(m => m.role !== 'inner' && m.geometry).map(m => m.geometry.filter(Boolean).map(p => L.latLng(p.lat, p.lon)));
        for (const shape of shapes) if (shape.length) {
            if (matches.length) habitats.push({ shape, types: matches.flatMap(h => h.types) });
            if (dangerous) hazards.push({ shape });
        }
    }
    for (const segment of segments) segment.zombieWeight = 1 + 4 * zombieRiskAt(roadInterpolate(segment.a.loc, segment.b.loc, 0.5), hazards);
    return { nodes, segments, habitats, hazards };
}
function zombieRiskAt(loc, hazards = ROAD_WORLD.hazards) {
    if (!loc) return 0;
    return hazards.reduce((risk, place) => Math.max(risk, Math.max(0, 1 - geometryDistance(loc, place.shape) / 150)), 0);
}
function resourceWeights(loc) {
    const weights = { wood: 20, scrap: 20, food: 12, fresh_food: 12, water: 20, medkit: 10, battery_resource: 5, battery_zombie: 5, healing_herb: 12, aromatic_herb: 12 };
    const bonuses = {};
    for (const habitat of ROAD_WORLD.habitats) {
        const proximity = Math.max(0, 1 - geometryDistance(loc, habitat.shape) / 120);
        for (const type of habitat.types) bonuses[type] = Math.max(bonuses[type] || 0, proximity);
    }
    for (const type in bonuses) weights[type] *= 1 + 5 * bonuses[type];
    return weights;
}
function chooseResource(loc) {
    const weights = resourceWeights(loc);
    let roll = Math.random() * Object.values(weights).reduce((a, b) => a + b, 0);
    for (const [type, weight] of Object.entries(weights)) { roll -= weight; if (roll <= 0) return type; }
    return 'wood';
}
function roadSpawnPoint(forZombie = false) {
    if (!STATE.playerLocation || !ROAD_WORLD.segments.length) return null;
    const candidates = ROAD_WORLD.segments.filter(s => getDistance(STATE.playerLocation, s.a.loc) <= CONFIG.spawnRadius + CONFIG.roadSegmentLength);
    const weight = s => s.length * (forZombie ? s.zombieWeight || 1 : 1);
    const total = candidates.reduce((sum, s) => sum + weight(s), 0);
    for (let attempt = 0; attempt < 50 && total; attempt++) {
        let roll = Math.random() * total;
        const segment = candidates.find(s => (roll -= weight(s)) <= 0) || candidates.at(-1);
        const t = Math.random(), loc = roadInterpolate(segment.a.loc, segment.b.loc, t);
        const distance = getDistance(STATE.playerLocation, loc);
        if (distance < CONFIG.minSpawnDistance || distance > CONFIG.spawnRadius || safeZoneContaining(loc)) continue;
        if ([...ENTITIES.resources, ...ENTITIES.zombies].some(e => getDistance(e.loc, loc) < CONFIG.minEntitySpacing)) continue;
        return { loc, from: segment.a.id, to: segment.b.id, t };
    }
    return null;
}
function nearestRoadNode(loc) {
    let best = null, distance = Infinity;
    for (const node of ROAD_WORLD.nodes.values()) { const d = getDistance(loc, node.loc); if (d < distance) { best = node; distance = d; } }
    return best;
}
function refreshRoadRoutes(now) {
    if (now - ROAD_WORLD.routeTime < CONFIG.routeRefreshMs) return;
    ROAD_WORLD.routeTime = now;
    const target = nearestRoadNode(STATE.playerLocation), distances = new Map(), queue = [];
    if (target) { distances.set(target.id, 0); queue.push([0, target.id]); }
    // Pequena fila de prioridade; só visita os nós conectados ao jogador.
    while (queue.length) {
        queue.sort((a, b) => b[0] - a[0]);
        const [cost, id] = queue.pop();
        if (cost !== distances.get(id)) continue;
        for (const [next, length] of ROAD_WORLD.nodes.get(id).links) {
            const candidate = cost + length;
            if (candidate < (distances.get(next) ?? Infinity)) { distances.set(next, candidate); queue.push([candidate, next]); }
        }
    }
    ROAD_WORLD.distances = distances;
}
function walkZombieRoad(zombie, elapsed, chasing) {
    let budget = elapsed * (chasing ? CONFIG.enemyChaseSpeed : CONFIG.enemyWalkSpeed);
    for (let steps = 0; budget > 0 && steps < 20; steps++) {
        const from = ROAD_WORLD.nodes.get(zombie.road.from), to = ROAD_WORLD.nodes.get(zombie.road.to);
        if (!from || !to) return;
        const remaining = getDistance(zombie.loc, to.loc);
        const step = Math.min(budget, remaining);
        const next = remaining > 0.001 ? roadInterpolate(zombie.loc, to.loc, step / remaining) : to.loc;
        if (segmentHitsSafeZone(zombie.loc, next)) {
            [zombie.road.from, zombie.road.to] = [zombie.road.to, zombie.road.from]; return;
        }
        queueZombieVisualMove(
            zombie,
            next,
            Math.max(220, Math.min(1500, elapsed * 950))
        );
        budget -= step;
        if (remaining > step + 0.001) return;
        const options = [...to.links.keys()];
        if (!options.length) return;
        let destination;
        if (chasing && ROAD_WORLD.distances.has(to.id)) {
            destination = options.filter(id => (ROAD_WORLD.distances.get(id) ?? Infinity) < ROAD_WORLD.distances.get(to.id))
                .sort((a, b) => ROAD_WORLD.distances.get(a) - ROAD_WORLD.distances.get(b))[0];
            if (!destination) return;
        } else {
            const forward = options.filter(id => id !== from.id);
            const choices = forward.length ? forward : options;
            destination = choices[Math.floor(Math.random() * choices.length)];
        }
        zombie.road = { from: to.id, to: destination };
    }
}
async function ensureRoadWorld() {
    if (!STATE.playerLocation || ROAD_WORLD.loading || STATE.isDead) return;
    if (ROAD_WORLD.center && getDistance(ROAD_WORLD.center, STATE.playerLocation) < CONFIG.worldRefreshDistance) return;
    if (Date.now() - ROAD_WORLD.attempted < CONFIG.worldRetryMs) return;
    ROAD_WORLD.loading = true; ROAD_WORLD.attempted = Date.now();
    const center = L.latLng(STATE.playerLocation.lat, STATE.playerLocation.lng);
    const around = `(around:${CONFIG.roadGraphRadius},${center.lat},${center.lng})`;
    const filters = new Set([...RESOURCE_HABITATS, ZOMBIE_HABITAT].flatMap(h => Object.entries(h.tags).map(([key, values]) => `["${key}"~"^(${values.join('|')})$"]`)));
    const query = `[out:json][timeout:25];(way["highway"~"^(${ROAD_TYPES})$"]${around};${[...filters].map(f => `nwr${f}${around};`).join('')});out geom;`;
    try {
        let data;
        for (const endpoint of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
            const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
            try {
                const response = await fetch(`${endpoint}?${new URLSearchParams({ data: query })}`, { signal: controller.signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const result = await response.json();
                if (!Array.isArray(result.elements) || result.remark) throw new Error('Resposta incompleta');
                data = result; break;
            } catch (error) { console.warn('Consulta de ruas indisponível', error); }
            finally { clearTimeout(timeout); }
        }
        if (!data) throw new Error('Sem dados');
        const world = buildRoadWorld(data.elements);
        if (!world.segments.length) throw new Error('Sem ruas próximas');
        // Uma nova região substitui as entidades da região anterior, sem teleportar zumbis entre ruas.
        for (const kind of ['resources', 'zombies']) { for (const entity of ENTITIES[kind]) map.removeLayer(entity.marker); ENTITIES[kind].length = 0; }
        Object.assign(ROAD_WORLD, world, { center, rawElements: data.elements, routeTime: 0, distances: new Map() });
        for (let i = 0; i < 12; i++) spawnResource();
        for (let i = 0; i < 6; i++) spawnZombie();
        await saveWorldCache();
        updateRadarVisibility();
    } catch (error) {
        console.warn('Não foi possível mapear esta área.', error);
    } finally { ROAD_WORLD.loading = false; ROAD_WORLD.attempted = Date.now(); }
}
