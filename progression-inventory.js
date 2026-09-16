// Progressão, mochila, armazenamento seguro e armadilhas reutilizáveis.
Object.assign(CONFIG, {
    trapKillXp: 25,
    trapReactivateScrap: 1,
    trapInteractRange: 25
});

Object.assign(STATE, {
    playerLevel: 1,
    playerXp: 0,
    backpackLevel: 1,
    safeStorage: {}
});

const BACKPACK_LEVELS = [
    null,
    { level: 1, capacity: 12, cost: null },
    { level: 2, capacity: 18, cost: { scrap: 4, wood: 2 } },
    { level: 3, capacity: 24, cost: { scrap: 8, wood: 4 } },
    { level: 4, capacity: 32, cost: { scrap: 14, wood: 6 } },
    { level: 5, capacity: 42, cost: { scrap: 22, wood: 10 } }
];

function xpNeededForLevel(level = STATE.playerLevel) {
    return 100 + Math.max(0, level - 1) * 50;
}

function awardPlayerXp(amount, reason = 'Armadilha') {
    const gained = Math.max(0, Math.round(Number(amount) || 0));
    if (!gained) return;

    STATE.playerXp += gained;
    let levels = 0;

    while (STATE.playerXp >= xpNeededForLevel(STATE.playerLevel)) {
        STATE.playerXp -= xpNeededForLevel(STATE.playerLevel);
        STATE.playerLevel++;
        levels++;
    }

    if (levels > 0) {
        showToast(`Nível ${STATE.playerLevel}! +${gained} XP por ${reason}.`, 'fa-star');
    } else {
        showToast(`+${gained} XP · ${reason}`, 'fa-star');
    }

    renderPlayerProgression();
    queueProgressSave();
}

function renderPlayerProgression() {
    const level = Math.max(1, Number(STATE.playerLevel) || 1);
    const xp = Math.max(0, Number(STATE.playerXp) || 0);
    const needed = xpNeededForLevel(level);
    const pct = Math.max(0, Math.min(100, xp / needed * 100));

    const levelEl = document.getElementById('player-level-label');
    const xpEl = document.getElementById('player-xp-label');
    const fill = document.getElementById('player-xp-fill');

    if (levelEl) levelEl.textContent = String(level);
    if (xpEl) xpEl.textContent = `${Math.floor(xp)} / ${needed} XP`;
    if (fill) fill.style.width = `${pct}%`;
}

function backpackLevelData(level = STATE.backpackLevel) {
    const normalized = Math.max(1, Math.min(BACKPACK_LEVELS.length - 1, Number(level) || 1));
    return BACKPACK_LEVELS[normalized];
}

function backpackCapacity() {
    return backpackLevelData().capacity;
}

function backpackUsedSlots() {
    return Object.values(STATE.inventory || {}).reduce((sum, value) => {
        const count = Number(value);
        return sum + (Number.isFinite(count) && count > 0 ? Math.floor(count) : 0);
    }, 0);
}

function backpackFreeSlots() {
    return Math.max(0, backpackCapacity() - backpackUsedSlots());
}

function canAddToBackpack(itemKey, amount = 1) {
    if (!ITEMS_DB[itemKey]) return false;
    return backpackUsedSlots() + Math.max(0, Math.floor(amount)) <= backpackCapacity();
}

function backpackUpgradeCostText(cost) {
    if (!cost) return 'Mochila no nível máximo.';
    return Object.entries(cost).map(([key, amount]) => {
        const def = ITEMS_DB[key];
        return `${def?.name || key}: ${STATE.inventory[key] || 0}/${amount}`;
    }).join(' · ');
}

function upgradeBackpack() {
    const current = backpackLevelData();
    const next = BACKPACK_LEVELS[current.level + 1];

    if (!next) {
        showToast('Sua mochila já está no nível máximo.', 'fa-box-open');
        return;
    }

    const canPay = Object.entries(next.cost).every(([key, amount]) => (STATE.inventory[key] || 0) >= amount);
    if (!canPay) {
        showToast('Faltam materiais para melhorar a mochila.', 'fa-hammer');
        return;
    }

    for (const [key, amount] of Object.entries(next.cost)) {
        STATE.inventory[key] -= amount;
    }

    STATE.backpackLevel = next.level;
    showToast(`Mochila nível ${next.level}: ${next.capacity} slots.`, 'fa-box-open');
    renderInventory();
    renderCrafting();
    queueProgressSave();
}

function playerHasSafeStorageAccess() {
    return !!(STATE.playerLocation && safeZoneContaining(STATE.playerLocation));
}

function storageCount(itemKey) {
    return Math.max(0, Math.floor(Number(STATE.safeStorage?.[itemKey]) || 0));
}

function depositToSafeStorage(itemKey, amount = 1) {
    if (!playerHasSafeStorageAccess()) {
        showToast('Entre em uma zona segura para acessar o armazém.', 'fa-lock');
        return;
    }
    if (!ITEMS_DB[itemKey]) return;

    const available = Math.max(0, Math.floor(STATE.inventory[itemKey] || 0));
    const move = Math.min(available, Math.max(1, Math.floor(amount)));
    if (!move) return;

    STATE.inventory[itemKey] = available - move;
    STATE.safeStorage[itemKey] = storageCount(itemKey) + move;

    renderInventory();
    renderCrafting();
    renderSafeStorage();
    queueProgressSave();
}

function withdrawFromSafeStorage(itemKey, amount = 1) {
    if (!playerHasSafeStorageAccess()) {
        showToast('Entre em uma zona segura para acessar o armazém.', 'fa-lock');
        return;
    }
    if (!ITEMS_DB[itemKey]) return;

    const available = storageCount(itemKey);
    const wanted = Math.min(available, Math.max(1, Math.floor(amount)));
    const move = Math.min(wanted, backpackFreeSlots());

    if (move <= 0) {
        showToast('Mochila cheia. Libere slots antes de retirar.', 'fa-box-open');
        return;
    }

    STATE.safeStorage[itemKey] = available - move;
    STATE.inventory[itemKey] = (STATE.inventory[itemKey] || 0) + move;

    if (STATE.safeStorage[itemKey] <= 0) delete STATE.safeStorage[itemKey];

    if (move < wanted) showToast(`Só havia espaço para ${move} item(ns).`, 'fa-box-open');

    renderInventory();
    renderCrafting();
    renderSafeStorage();
    queueProgressSave();
}

function depositAllToSafeStorage() {
    if (!playerHasSafeStorageAccess()) {
        showToast('Entre em uma zona segura para acessar o armazém.', 'fa-lock');
        return;
    }

    let moved = 0;
    for (const [key, count] of Object.entries(STATE.inventory)) {
        const amount = Math.max(0, Math.floor(Number(count) || 0));
        if (!amount || !ITEMS_DB[key]) continue;
        STATE.safeStorage[key] = storageCount(key) + amount;
        STATE.inventory[key] = 0;
        moved += amount;
    }

    if (moved) showToast(`${moved} item(ns) guardado(s) no armazém seguro.`, 'fa-warehouse');
    renderInventory();
    renderCrafting();
    renderSafeStorage();
    queueProgressSave();
}

function openSafeStoragePanel(button = null) {
    if (!playerHasSafeStorageAccess()) {
        showToast('Entre em uma zona segura para acessar o armazém.', 'fa-lock');
        updateSafeZoneContextMenu();
        return;
    }
    togglePanel('storage', button || document.getElementById('storage-nav-button'));
}

function updateSafeZoneContextMenu() {
    const button = document.getElementById('storage-nav-button');
    const allowed = playerHasSafeStorageAccess();

    if (button) {
        button.hidden = !allowed;
        button.disabled = !allowed;
        button.setAttribute('aria-hidden', String(!allowed));
        if (!allowed) button.classList.remove('active');
    }

    const storagePanel = document.getElementById('panel-storage');
    if (!allowed && storagePanel?.classList.contains('active')) {
        togglePanel('radar');
        showToast('Você saiu da zona segura. Armazém fechado.', 'fa-lock');
    }
}

function renderSafeStorageBackpack() {
    const grid = document.getElementById('safe-storage-backpack-grid');
    const slots = document.getElementById('storage-backpack-slots');
    if (!grid) return;

    if (slots) slots.textContent = `${backpackUsedSlots()} / ${backpackCapacity()} slots`;

    const carried = Object.entries(STATE.inventory || {})
        .filter(([key, count]) => ITEMS_DB[key] && Number(count) > 0);

    if (!carried.length) {
        grid.innerHTML = `<div class="storage-item text-center"><i class="fa-solid fa-box-open"></i><strong>Mochila vazia</strong><span>Nenhum item para guardar.</span></div>`;
        return;
    }

    grid.innerHTML = carried.map(([key, count]) => {
        const item = ITEMS_DB[key];
        return `
          <div class="storage-item">
            <div class="storage-item-top">
              <i class="fa-solid ${item.icon}"></i>
              <div><strong>${item.name}</strong><span>${count} na mochila</span></div>
            </div>
            <button type="button" class="sketch-card-button is-green" onclick="depositToSafeStorage('${key}',1)">GUARDAR 1</button>
          </div>`;
    }).join('');
}

function renderSafeStorage() {
    const access = document.getElementById('safe-storage-access');
    const message = document.getElementById('safe-storage-message');
    const actions = document.getElementById('safe-storage-actions');
    const grid = document.getElementById('safe-storage-grid');
    if (!access || !message || !actions || !grid) return;

    const allowed = playerHasSafeStorageAccess();
    access.className = `storage-access ${allowed ? 'open' : 'locked'}`;
    access.textContent = allowed ? 'ACESSO LIBERADO' : 'BLOQUEADO';

    if (!allowed) {
        message.textContent = 'Entre em uma zona segura para acessar o armazém.';
        actions.innerHTML = '';
        grid.innerHTML = `<div class="storage-item text-center"><i class="fa-solid fa-lock"></i><strong>Armazém bloqueado</strong></div>`;
        return;
    }

    message.textContent = 'Tudo que você guardar aqui pode ser retirado em qualquer outra zona segura.';
    actions.innerHTML = backpackUsedSlots() > 0
        ? `<button type="button" class="sketch-card-button is-green" onclick="depositAllToSafeStorage()"><i class="fa-solid fa-box-archive"></i> GUARDAR TUDO</button>`
        : '';

    renderSafeStorageBackpack();

    const stored = Object.entries(STATE.safeStorage || {})
        .filter(([key, count]) => ITEMS_DB[key] && Number(count) > 0);

    if (!stored.length) {
        grid.innerHTML = `<div class="storage-item text-center"><i class="fa-solid fa-box-open"></i><strong>Armazém vazio</strong><span>Guarde itens da mochila.</span></div>`;
        return;
    }

    grid.innerHTML = stored.map(([key, count]) => {
        const item = ITEMS_DB[key];
        return `
          <div class="storage-item">
            <div class="storage-item-top">
              <i class="fa-solid ${item.icon}"></i>
              <div><strong>${item.name}</strong><span>${count} guardado(s)</span></div>
            </div>
            <button type="button" class="sketch-card-button" onclick="withdrawFromSafeStorage('${key}',1)">RETIRAR 1</button>
          </div>`;
    }).join('');
}

function renderBackpackOverview() {
    const current = backpackLevelData();
    const next = BACKPACK_LEVELS[current.level + 1];
    const used = backpackUsedSlots();
    const cap = current.capacity;
    const pct = Math.max(0, Math.min(100, used / cap * 100));

    const level = document.getElementById('backpack-level-label');
    const slots = document.getElementById('backpack-slots-label');
    const fill = document.getElementById('backpack-capacity-fill');
    const info = document.getElementById('backpack-upgrade-info');
    const button = document.getElementById('backpack-upgrade-btn');

    if (level) level.textContent = String(current.level);
    if (slots) slots.textContent = `${used} / ${cap} slots`;
    if (fill) {
        fill.style.width = `${pct}%`;
        fill.classList.toggle('warning', pct >= 75 && pct < 100);
        fill.classList.toggle('full', pct >= 100);
    }

    if (info) {
        info.textContent = next
            ? `Próximo nível: ${next.capacity} slots · ${backpackUpgradeCostText(next.cost)}`
            : `Capacidade máxima: ${cap} slots.`;
    }

    if (button) {
        button.disabled = !next;
        button.textContent = next ? `MELHORAR PARA ${next.capacity} SLOTS` : 'MOCHILA NO MÁXIMO';
    }
}


function openInventoryItemInfo(itemKey) {
    const itemDef = ITEMS_DB[itemKey];
    const modal = document.getElementById('inventory-item-info-modal');
    if (!itemDef || !modal) return;

    const count = Math.max(0, Math.floor(Number(STATE.inventory?.[itemKey]) || 0));
    const icon = document.getElementById('inventory-item-info-icon');
    const title = document.getElementById('inventory-item-info-title');
    const description = document.getElementById('inventory-item-info-description');
    const countLabel = document.getElementById('inventory-item-info-count');
    const slotsLabel = document.getElementById('inventory-item-info-slots');

    if (icon) icon.className = `fa-solid ${itemDef.icon || 'fa-circle-info'}`;
    if (title) title.textContent = itemDef.name || 'Item';
    if (description) description.textContent = itemDef.desc || 'Sem descrição.';
    if (countLabel) countLabel.textContent = String(count);
    if (slotsLabel) slotsLabel.textContent = String(count);

    modal.hidden = false;
}

function closeInventoryItemInfo() {
    const modal = document.getElementById('inventory-item-info-modal');
    if (modal) modal.hidden = true;
}

function inventoryItemCard(itemKey, count) {
    const itemDef = ITEMS_DB[itemKey];
    if (!itemDef) return '';

    let useButton = '';
    if (itemDef.type === 'consumable' || itemDef.type === 'placeable') {
        useButton = `<button onclick="ITEMS_DB['${itemKey}'].use('${itemKey}')" class="sketch-card-button">${itemDef.actionText}</button>`;
    }

    const infoButton = `
        <button type="button"
                class="sketch-card-button is-blue inventory-info-button"
                onclick="openInventoryItemInfo('${itemKey}')"
                aria-label="Informações sobre ${itemDef.name}"
                title="Informações">
            <i class="fa-solid fa-circle-info"></i>
        </button>`;

    return `
      <div class="sketch-grid-item inventory-card flex flex-col items-center text-center">
        <span class="inventory-count-badge">${count}</span>

        <div class="inventory-card-main">
          <div class="mb-2">
            <i class="fa-solid ${itemDef.icon} text-3xl" style="color:var(--ink-color)"></i>
          </div>
          <span class="font-bold text-sm">${itemDef.name}</span>
        </div>

        <div class="inventory-item-actions ${useButton ? '' : 'only-info'}">
          ${useButton}
          ${infoButton}
        </div>
      </div>`;
}

// Substitui o render antigo por uma versão com capacidade real e armazém.
renderInventory = function renderInventoryEnhanced() {
    saveFenceProgress();
    renderSurvivalStatus();
    renderPlayerProgression();
    renderBackpackOverview();

    const grid = document.getElementById('inventory-grid');
    if (!grid) return;

    const items = Object.entries(STATE.inventory || {}).filter(([key, count]) => ITEMS_DB[key] && Number(count) > 0);

    grid.innerHTML = items.length
        ? items.map(([key, count]) => inventoryItemCard(key, Math.floor(count))).join('')
        : `<div class="col-span-full text-center p-8 flex flex-col items-center"><i class="fa-solid fa-ghost text-4xl mb-2 opacity-50"></i><p class="font-bold">Mochila vazia.</p><p class="text-xs">Você tem ${backpackFreeSlots()} slots livres.</p></div>`;
};

function trapIcon(active) {
    return L.divIcon({
        className: '',
        html: `<div class="trap-map-icon ${active ? 'active' : 'inactive'}"><i class="fa-solid ${active ? 'fa-burst' : 'fa-screwdriver-wrench'}"></i></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
    });
}

function refreshTrapMarker(trap) {
    if (!trap?.marker) return;
    trap.marker.setIcon(trapIcon(!!trap.active));
    trap.marker.setZIndexOffset(trap.active ? 350 : 250);
}

function createTrapEntity(loc, saved = {}) {
    const point = L.latLng(loc.lat, loc.lng);
    const trap = {
        id: saved.id || `trap-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
        loc: point,
        radius: Number(saved.radius) > 0 ? Number(saved.radius) : CONFIG.trapRadius,
        active: saved.active !== false,
        kills: Math.max(0, Math.floor(Number(saved.kills) || 0)),
        marker: null
    };

    trap.marker = L.marker(point, {
        icon: trapIcon(trap.active),
        keyboard: false,
        riseOnHover: true
    }).addTo(map);

    trap.marker.on('click', () => interactTrap(trap));
    ENTITIES.traps.push(trap);
    return trap;
}

function interactTrap(trap) {
    if (!trap || !STATE.playerLocation) return;

    const distance = getDistance(STATE.playerLocation, trap.loc);

    if (trap.active) {
        showToast(`Armadilha ativa · ${trap.kills} eliminação(ões).`, 'fa-burst');
        return;
    }

    if (distance > CONFIG.trapInteractRange) {
        showToast(`Aproxime-se da armadilha (${Math.round(distance)} m).`, 'fa-person-walking');
        return;
    }

    if ((STATE.inventory.scrap || 0) < CONFIG.trapReactivateScrap) {
        showToast('É necessária 1 sucata para reativar a armadilha.', 'fa-gear');
        return;
    }

    STATE.inventory.scrap -= CONFIG.trapReactivateScrap;
    trap.active = true;
    refreshTrapMarker(trap);

    showToast('Armadilha reativada com 1 sucata.', 'fa-burst');
    renderInventory();
    renderCrafting();
    queueProgressSave();
}

function triggerTrapKill(trap) {
    if (!trap?.active) return;

    trap.active = false;
    trap.kills = Math.max(0, Number(trap.kills) || 0) + 1;
    refreshTrapMarker(trap);

    awardPlayerXp(CONFIG.trapKillXp, 'zumbi abatido por armadilha');
    showToast('Armadilha disparada. Toque nela perto para reativar com 1 sucata.', 'fa-gear');
    queueProgressSave();
}

// O item fabricado instala uma armadilha persistente.
placeTrap = function placePersistentTrap(itemKey) {
    if ((STATE.inventory[itemKey] || 0) <= 0 || !STATE.playerLocation) return;

    STATE.inventory[itemKey]--;
    createTrapEntity(STATE.playerLocation, { active: true, kills: 0 });

    showToast('Armadilha instalada. Ela ficará no mapa após disparar.', 'fa-burst');
    renderInventory();
    queueProgressSave();
    togglePanel('radar');
};
ITEMS_DB.trap.use = placeTrap;
ITEMS_DB.trap.desc = 'Elimina 1 zumbi, dá XP e fica desativada no mapa. Reative perto dela usando 1 sucata.';
ITEMS_DB.trap.actionText = 'Instalar';

// Capacidade aplicada apenas a itens físicos. Baterias continuam recarregando diretamente o radar.
const collectResourceBeforeBackpack = collectResource;
collectResource = function collectResourceWithBackpack(resource) {
    if (!resource) return;

    const physicalItem = !isBatteryResource(resource);
    if (physicalItem && !canAddToBackpack(resource.type, 1)) {
        showToast(`Mochila cheia (${backpackUsedSlots()}/${backpackCapacity()} slots). Guarde itens em uma zona segura ou melhore a mochila.`, 'fa-box-open');
        return;
    }

    return collectResourceBeforeBackpack(resource);
};

const updateResourceCollectableStateBeforeBackpack = updateResourceCollectableState;
updateResourceCollectableState = function updateResourceCollectableStateWithBackpack(resource) {
    updateResourceCollectableStateBeforeBackpack(resource);

    const element = resource?.marker?.getElement?.();
    const icon = element?.querySelector('.resource-map-icon');
    if (!icon) return;

    const close = canCollectResource(resource);
    const full = close && !isBatteryResource(resource) && !canAddToBackpack(resource.type, 1);
    icon.classList.toggle('bag-full', full);
};

// HUD e UI passam a mostrar nível sempre que os status forem atualizados.
const updateStatsUIBeforeProgress = updateStatsUI;
updateStatsUI = function updateStatsUIWithProgress() {
    updateStatsUIBeforeProgress();
    renderPlayerProgression();
};

// Se o painel estiver aberto, entrar/sair de uma zona segura atualiza o armazém automaticamente.
const updateFatigueBeforeStorage = updateFatigue;
updateFatigue = function updateFatigueWithStorage(elapsed) {
    const before = playerHasSafeStorageAccess();
    updateFatigueBeforeStorage(elapsed);
    const after = playerHasSafeStorageAccess();

    updateSafeZoneContextMenu();

    if (before !== after && document.getElementById('panel-inventory')?.classList.contains('active')) {
        renderInventory();
    }

    if (after && document.getElementById('panel-storage')?.classList.contains('active')) {
        renderSafeStorage();
    }
};

function queueProgressSave() {
    if (typeof queueGameSave === 'function') queueGameSave();
}
