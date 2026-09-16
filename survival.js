// Regras de sobrevivência e balanceamento inicial.
Object.assign(CONFIG, {
    maxZombies: 30, hordeInterval: 45000, hordeChance: 0.35,
    chaseChance: 0.35, chaseCheckInterval: 8000, chaseDuration: 15000,
    freeChaseRadius: 35, fatiguePerSecond: 0.025, fatiguePerMeter: 0.035,
    restRecoveryPerSecond: 1.2, repellentDuration: 90000,

    // Balanceamento de dano dos zumbis.
    // Jogador saudável: 4 de dano.
    // Fome/sede/fadiga máximas: até 10 de dano.
    zombieDamageMaxMultiplier: 2.5,
    zombieDamageHungerWeight: 0.35,
    zombieDamageThirstWeight: 0.40,
    zombieDamageFatigueWeight: 0.25
});
Object.assign(STATE, { fatigue: 0, resting: false, restOrigin: null, fatigueAnchor: null, fatigueWarned: false, repellentUntil: 0, lastHordeCheck: Date.now() });
Object.assign(ITEMS_DB, {
    fresh_food: { name: 'Alimentos frescos', icon: 'fa-carrot', color: 'text-orange-500', type: 'material', desc: 'Precisam ser preparados no Craft antes de comer.' },
    cooked_food: { name: 'Refeição preparada', icon: 'fa-bowl-food', color: 'text-orange-600', type: 'consumable', desc: 'Recupera 75 de fome.', hungerRestore: 75, actionText: 'Comer', use: useFood },
    healing_herb: { name: 'Erva medicinal', icon: 'fa-seedling', color: 'text-green-600', type: 'material', desc: 'Use no Craft para preparar medicina.' },
    aromatic_herb: { name: 'Erva aromática', icon: 'fa-leaf', color: 'text-lime-600', type: 'material', desc: 'Use no Craft para fabricar repelente.' },
    herbal_medicine: { name: 'Medicina de ervas', icon: 'fa-mortar-pestle', color: 'text-green-600', type: 'consumable', desc: 'Recupera 40 de vida.', actionText: 'Curar', use: useMedkit },
    repellent: { name: 'Repelente de zumbis', icon: 'fa-spray-can-sparkles', color: 'text-lime-600', type: 'consumable', desc: 'Evita perseguições e ataques por 90 segundos.', actionText: 'Aplicar', use: useRepellent }
});
CRAFTING_RECIPES.push(
    { result: 'cooked_food', name: 'Refeição preparada', desc: 'Cozinhe alimentos frescos. Recupera 75 de fome.', icon: 'fa-bowl-food', cost: { fresh_food: 2, water: 1, wood: 1 } },
    { result: 'herbal_medicine', name: 'Medicina de ervas', desc: 'Recupera 40 de vida.', icon: 'fa-mortar-pestle', cost: { healing_herb: 3, water: 1 } },
    { result: 'repellent', name: 'Repelente de zumbis', desc: 'Protege de perseguições e ataques por 90 segundos.', icon: 'fa-spray-can-sparkles', cost: { aromatic_herb: 3, water: 1 } }
);
RESOURCE_HABITATS.push(
    { types: ['healing_herb'], label: 'Ervas medicinais', places: 'Jardins, parques, hortas e florestas', tags: { leisure: ['garden', 'park'], landuse: ['allotments', 'forest'], natural: ['wood'] } },
    { types: ['aromatic_herb'], label: 'Ervas aromáticas', places: 'Jardins, parques, campos e pomares', tags: { leisure: ['garden', 'park'], landuse: ['meadow', 'orchard'], natural: ['scrub', 'grassland'] } }
);
function calculateZombieDamage() {
    const hunger = Math.max(0, Math.min(100, Number(STATE.hunger) || 0));
    const thirst = Math.max(0, Math.min(100, Number(STATE.thirst) || 0));
    const fatigue = Math.max(0, Math.min(100, Number(STATE.fatigue) || 0));

    // Fome e sede armazenam o quanto ainda resta:
    // 100 = bem alimentado/hidratado, 0 = condição crítica.
    const hungerDeficit = (100 - hunger) / 100;
    const thirstDeficit = (100 - thirst) / 100;

    // Fadiga funciona ao contrário:
    // 0 = descansado, 100 = exausto.
    const fatigueLevel = fatigue / 100;

    const vulnerability =
        hungerDeficit * CONFIG.zombieDamageHungerWeight +
        thirstDeficit * CONFIG.zombieDamageThirstWeight +
        fatigueLevel * CONFIG.zombieDamageFatigueWeight;

    const multiplier = 1 + vulnerability * (CONFIG.zombieDamageMaxMultiplier - 1);

    return Math.max(
        CONFIG.zombieDamage,
        Math.min(
            CONFIG.zombieDamage * CONFIG.zombieDamageMaxMultiplier,
            CONFIG.zombieDamage * multiplier
        )
    );
}

function playerProtected(now = Date.now()) {
    return !!STATE.playerLocation && (!!safeZoneContaining(STATE.playerLocation) || STATE.repellentUntil > now);
}
function useRepellent(itemKey) {
    if (!(STATE.inventory[itemKey] > 0)) return;
    if (STATE.repellentUntil > Date.now()) { showToast('O repelente ainda está ativo.'); return; }
    STATE.inventory[itemKey]--;
    STATE.repellentUntil = Date.now() + CONFIG.repellentDuration;
    for (const zombie of ENTITIES.zombies) zombie.chasingUntil = 0;
    showToast('Repelente ativo por 90 segundos.'); renderInventory(); renderSurvivalStatus();
}
function toggleRest() {
    showToast('O descanso agora é automático dentro de zonas seguras.');
}
function trackFatigueMovement(loc) {
    const safe = !!safeZoneContaining(loc);
    if (!STATE.fatigueAnchor) { STATE.fatigueAnchor = loc; return; }
    const distance = getDistance(STATE.fatigueAnchor, loc);
    // Pequenas oscilações do GPS não contam como caminhada.
    if (distance >= 8) {
        if (distance <= CONFIG.teleportDistance && !safe) {
            STATE.fatigue = Math.min(100, STATE.fatigue + distance * CONFIG.fatiguePerMeter);
        }
        STATE.fatigueAnchor = loc;
    }
}
function updateFatigue(elapsed) {
    const safe = !!(STATE.playerLocation && safeZoneContaining(STATE.playerLocation));
    const wasResting = STATE.resting;

    if (safe && STATE.fatigue > 0) {
        STATE.resting = true;
        STATE.fatigue = Math.max(0, STATE.fatigue - elapsed * CONFIG.restRecoveryPerSecond);
        if (!wasResting) showToast('Zona segura: descanso automático iniciado.');
        if (STATE.fatigue <= 0) {
            STATE.fatigue = 0;
            STATE.resting = false;
            if (wasResting) showToast('Descanso concluído.');
        }
    } else {
        if (wasResting && !safe) showToast('Você saiu da zona segura. Descanso interrompido.');
        STATE.resting = false;
        if (!safe) STATE.fatigue = Math.min(100, STATE.fatigue + elapsed * CONFIG.fatiguePerSecond);
    }

    if (STATE.fatigue >= 80 && !STATE.fatigueWarned) {
        showToast('Fadiga alta: entre em uma zona segura para descansar.');
        STATE.fatigueWarned = true;
    }
    if (STATE.fatigue < 60) STATE.fatigueWarned = false;
    renderSurvivalStatus();
}
function renderSurvivalStatus() {
    const fatigueText = document.getElementById('ui-fatigue-text');
    const fatigueBar = document.getElementById('ui-fatigue-bar');
    if (fatigueText) fatigueText.textContent = `${Math.round(STATE.fatigue)}%`;
    if (fatigueBar) fatigueBar.style.width = `${STATE.fatigue}%`;
}
function zombieWantsToChase(zombie, now) {
    const distance = getDistance(zombie.loc, STATE.playerLocation);
    if (playerProtected(now) || distance > CONFIG.zombieAggroRange) { zombie.chasingUntil = 0; return false; }
    if ((zombie.chasingUntil || 0) > now) return true;
    if (now >= (zombie.nextChaseCheck || 0)) {
        zombie.nextChaseCheck = now + CONFIG.chaseCheckInterval;
        const chance = Math.min(0.85, CONFIG.chaseChance + (STATE.fatigue >= 80 ? 0.2 : 0));
        if (Math.random() < chance) zombie.chasingUntil = now + CONFIG.chaseDuration;
    }
    return (zombie.chasingUntil || 0) > now;
}
function moveZombieDirect(zombie, target, budget, visualDurationMs = CONFIG.zombieVisualMoveMs) {
    const distance = getDistance(zombie.loc, target);
    if (distance < 0.05) return true;
    const next = roadInterpolate(zombie.loc, target, Math.min(1, budget / distance));
    if (segmentHitsSafeZone(zombie.loc, next)) return false;
    queueZombieVisualMove(zombie, next, visualDurationMs);
    return distance <= budget;
}
function moveSurvivalZombie(zombie, elapsed, chasing) {
    const near = getDistance(zombie.loc, STATE.playerLocation) <= CONFIG.freeChaseRadius;
    const visualDuration = Math.max(220, Math.min(1500, elapsed * 950));

    if (chasing && near && !playerProtected()) {
        if (!zombie.returnToRoad) zombie.returnToRoad = L.latLng(zombie.loc.lat, zombie.loc.lng);
        moveZombieDirect(zombie, STATE.playerLocation, CONFIG.enemyChaseSpeed * elapsed, visualDuration);
    } else if (zombie.returnToRoad) {
        if (moveZombieDirect(zombie, zombie.returnToRoad, CONFIG.enemyWalkSpeed * elapsed, visualDuration)) zombie.returnToRoad = null;
    } else {
        walkZombieRoad(zombie, elapsed, chasing);
    }
}
function spawnHorde() {
    if (ENTITIES.zombies.length > CONFIG.maxZombies - 3) return 0;
    const anchor = roadSpawnPoint(true); if (!anchor) return 0;
    const reachable = new Set([anchor.from]), pending = [anchor.from];
    while (pending.length) {
        const id = pending.pop(), node = ROAD_WORLD.nodes.get(id);
        for (const next of node.links.keys()) if (!reachable.has(next) && getDistance(anchor.loc, ROAD_WORLD.nodes.get(next).loc) < 55) { reachable.add(next); pending.push(next); }
    }
    const segments = ROAD_WORLD.segments.filter(s => reachable.has(s.a.id) && reachable.has(s.b.id));
    const planned = [], desired = Math.min(CONFIG.maxZombies - ENTITIES.zombies.length, 3 + Math.floor(Math.random() * 3));
    for (let attempt = 0; attempt < 120 && planned.length < desired && segments.length; attempt++) {
        const segment = segments[Math.floor(Math.random() * segments.length)];
        const loc = roadInterpolate(segment.a.loc, segment.b.loc, Math.random());
        const distance = getDistance(loc, STATE.playerLocation);
        if (distance < CONFIG.minSpawnDistance || distance > CONFIG.spawnRadius || safeZoneContaining(loc)) continue;
        if ([...ENTITIES.zombies, ...ENTITIES.resources, ...planned].some(e => getDistance(e.loc, loc) < 6)) continue;
        planned.push({ loc, from: segment.a.id, to: segment.b.id });
    }
    if (planned.length < 3) return 0;
    const hordeId = `horde-${Date.now()}`;
    for (const spawn of planned) spawnZombie(spawn, hordeId);
    showToast(`Uma horda de ${planned.length} zumbis chegou às ruas!`, 'fa-skull');
    return planned.length;
}
function updateHordes(now) {
    if (now - STATE.lastHordeCheck < CONFIG.hordeInterval) return;
    STATE.lastHordeCheck = now;
    if (Math.random() < CONFIG.hordeChance + 0.3 * zombieRiskAt(STATE.playerLocation)) spawnHorde();
}
