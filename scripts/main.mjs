const MODULE_ID = "pf2e-hover-preview";

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

const settings = {
    browser: true,
    links: true,
    delay: 300,
    modifier: "none",
    width: 460,
};

function registerSettings() {
    const register = (key, data) =>
        game.settings.register(MODULE_ID, key, {
            scope: "client",
            config: true,
            ...data,
            onChange: (value) => {
                settings[key] = value;
                closeFrom(0);
            },
        });

    register("browser", {
        name: "PF2EHP.Settings.Browser.Name",
        hint: "PF2EHP.Settings.Browser.Hint",
        type: Boolean,
        default: true,
    });
    register("links", {
        name: "PF2EHP.Settings.Links.Name",
        hint: "PF2EHP.Settings.Links.Hint",
        type: Boolean,
        default: true,
    });
    register("delay", {
        name: "PF2EHP.Settings.Delay.Name",
        hint: "PF2EHP.Settings.Delay.Hint",
        type: Number,
        range: { min: 0, max: 1500, step: 50 },
        default: 300,
    });
    register("modifier", {
        name: "PF2EHP.Settings.Modifier.Name",
        hint: "PF2EHP.Settings.Modifier.Hint",
        type: String,
        choices: {
            none: "PF2EHP.Settings.Modifier.None",
            shift: "PF2EHP.Settings.Modifier.Shift",
            ctrl: "PF2EHP.Settings.Modifier.Control",
            alt: "PF2EHP.Settings.Modifier.Alt",
        },
        default: "none",
    });
    register("width", {
        name: "PF2EHP.Settings.Width.Name",
        hint: "PF2EHP.Settings.Width.Hint",
        type: Number,
        range: { min: 300, max: 800, step: 20 },
        default: 460,
    });

    for (const key of Object.keys(settings)) settings[key] = game.settings.get(MODULE_ID, key);
}

function modifierHeld(event) {
    switch (settings.modifier) {
        case "shift":
            return event.shiftKey;
        case "ctrl":
            return event.ctrlKey || event.metaKey;
        case "alt":
            return event.altKey;
        default:
            return true;
    }
}

/* -------------------------------------------- */
/*  Hover source detection                      */
/* -------------------------------------------- */

/**
 * Find the hoverable thing under an element, if any.
 * @returns {{ el: HTMLElement, getUuid: () => string | null } | null}
 */
function findSource(target) {
    if (!(target instanceof Element)) return null;

    if (settings.browser) {
        const li = target.closest(".browser-tab ul.result-list > li");
        if (li) return { el: li, getUuid: () => uuidFromBrowserRow(li) };
    }

    if (settings.links) {
        const link = target.closest("a.content-link[data-uuid]");
        if (link && !link.classList.contains("broken")) {
            const type = link.dataset.type;
            if (!type || type === "Item" || type === "Actor") {
                return { el: link, getUuid: () => link.dataset.uuid };
            }
        }
    }

    return null;
}

/**
 * The browser's result rows carry no UUID in the DOM, but they are rendered in the same order as the
 * active tab's `results` array, so the row's position identifies the entry. The name is checked as a guard.
 */
function uuidFromBrowserRow(li) {
    const tabName = li.closest(".browser-tab")?.dataset.tabName;
    const results = game.pf2e?.compendiumBrowser?.tabs?.[tabName]?.results;
    if (!results?.length) return null;

    const name = li.querySelector(".result-link")?.textContent.trim();
    const index = Array.prototype.indexOf.call(li.parentElement.children, li);
    let entry = results[index];
    if (entry?.name !== name) {
        const img = li.querySelector("img")?.getAttribute("src");
        entry = results.find((r) => r.name === name && r.img === img) ?? results.find((r) => r.name === name);
    }
    return entry?.uuid ?? null;
}

/* -------------------------------------------- */
/*  Card stack & hover state                    */
/* -------------------------------------------- */

/** Open cards, outermost first. A card opened from a link inside another card stacks on top of it. */
const stack = [];
let pending = null; // { el, timer }
let lastPointer = { x: 0, y: 0, target: null };
let closeTimer = null;
let showSeq = 0;

function closeFrom(depth) {
    while (stack.length > depth) stack.pop().card.remove();
}

function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
}

function isHovered(el) {
    return !!el?.isConnected && el.matches(":hover");
}

/** Close every card that neither it, its source, nor a card above it is under the pointer. */
function scheduleCloseCheck() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
        let keep = 0;
        for (let i = stack.length - 1; i >= 0; i--) {
            if (isHovered(stack[i].card) || isHovered(stack[i].source)) {
                keep = i + 1;
                break;
            }
        }
        closeFrom(keep);
    }, 150);
}

function depthFor(el) {
    for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].card.contains(el)) return i + 1;
    }
    return 0;
}

function tryHover(target, event) {
    const source = findSource(target);
    if (!source) return;
    if (!modifierHeld(event)) return;
    if (pending?.el === source.el) return;
    if (stack.some((s) => s.source === source.el)) return;

    cancelPending();
    pending = {
        el: source.el,
        timer: setTimeout(() => {
            pending = null;
            show(source, lastPointer.x, lastPointer.y);
        }, settings.delay),
    };
}

async function show(source, x, y) {
    if (!isHovered(source.el)) return;
    const seq = ++showSeq;

    const uuid = source.getUuid();
    if (!uuid) return;

    let html;
    try {
        html = await renderCardContent(uuid);
    } catch (err) {
        console.error(`${MODULE_ID} | Failed to build preview for ${uuid}`, err);
        return;
    }
    if (!html || seq !== showSeq || !isHovered(source.el)) return;

    const depth = depthFor(source.el);
    closeFrom(depth);

    const card = document.createElement("div");
    card.className = "pf2e-hover-preview chat-message";
    card.style.width = `${settings.width}px`;
    card.innerHTML = html;
    card.addEventListener("mouseleave", scheduleCloseCheck);
    card.querySelector(".hp-title")?.addEventListener("click", async () => {
        closeFrom(0);
        const doc = await fromUuid(uuid);
        doc?.sheet?.render(true);
    });
    document.body.append(card);
    position(card, x, y);
    stack.push({ card, source: source.el });
}

function position(card, x, y) {
    const margin = 8;
    const offset = 16;
    const { width, height } = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + offset;
    if (left + width > vw - margin) left = x - offset - width;
    left = Math.max(margin, Math.min(left, vw - margin - width));

    let top = y + offset;
    if (top + height > vh - margin) top = y - offset - height;
    top = Math.max(margin, Math.min(top, vh - margin - height));

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
}

function activateListeners() {
    document.addEventListener(
        "mousemove",
        (event) => {
            lastPointer = { x: event.clientX, y: event.clientY, target: event.target };
        },
        { passive: true },
    );

    document.addEventListener("mouseover", (event) => tryHover(event.target, event));

    document.addEventListener("mouseout", (event) => {
        if (pending && !pending.el.contains(event.relatedTarget)) cancelPending();
        if (stack.length) scheduleCloseCheck();
    });

    // Pressing the required key while already resting on something shows its preview.
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && stack.length) {
            closeFrom(0);
            return;
        }
        if (settings.modifier !== "none" && !event.repeat && lastPointer.target) {
            tryHover(lastPointer.target, event);
        }
    });

    // Clicking, dragging or scrolling outside the cards dismisses them.
    const dismiss = (event) => {
        cancelPending();
        if (!stack.length) return;
        const depth = depthFor(event.target);
        closeFrom(depth);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("dragstart", dismiss, true);
    document.addEventListener("wheel", dismiss, { capture: true, passive: true });
}

/* -------------------------------------------- */
/*  Card rendering                              */
/* -------------------------------------------- */

/** Compendium documents never change during a session, so their rendered cards are cached. */
const cache = new Map();
const CACHE_LIMIT = 100;

async function renderCardContent(uuid) {
    const cacheable = uuid.startsWith("Compendium.");
    if (cacheable && cache.has(uuid)) return cache.get(uuid);

    const doc = await fromUuid(uuid);
    if (!doc || !["Item", "Actor"].includes(doc.documentName)) return null;

    const html = doc.documentName === "Item" ? await itemCard(doc) : await actorCard(doc);

    if (cacheable) {
        cache.set(uuid, html);
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    }
    return html;
}

const L = (key) => game.i18n.localize(`PF2EHP.Card.${key}`);

function esc(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
}

function signed(n) {
    return n >= 0 ? `+${n}` : `${n}`;
}

async function enrich(text, doc) {
    if (!text?.trim()) return "";
    const TextEditor = foundry.applications.ux.TextEditor.implementation;
    try {
        return await TextEditor.enrichHTML(text, {
            relativeTo: doc,
            rollData: doc.getRollData?.() ?? {},
            secrets: doc.isOwner,
        });
    } catch (err) {
        console.warn(`${MODULE_ID} | Enrichment failed for ${doc.uuid}`, err);
        return text;
    }
}

function header(doc, { glyph = null, kind, level = null }) {
    const levelText = level !== null && level !== undefined ? ` ${esc(level)}` : "";
    return `
        <header class="card-header flexrow">
            <img src="${esc(doc.img)}" alt="">
            <h3><span class="hp-title" data-tooltip="${esc(L("OpenSheet"))}">${esc(doc.name)}</span>${glyph ? ` <span class="action-glyph">${esc(glyph)}</span>` : ""}</h3>
            <h4 class="level">${esc(kind)}${levelText}</h4>
        </header>`;
}

/** Wrap card parts in PF2e's own chat-card markup so the system's styles apply. */
function cardShell(headerHtml, tagsHtml, propsHtml, descriptionHtml) {
    const content = [propsHtml, propsHtml && descriptionHtml ? "<hr>" : "", descriptionHtml].join("");
    return `
        <div class="pf2e chat-card item-card">
            ${headerHtml}
            ${tagsHtml}
            ${content ? `<section class="card-content">${content}</section>` : ""}
        </div>`;
}

function traitTags(rarity, traits) {
    const tags = [];
    if (rarity && rarity !== "common") {
        const label = game.i18n.localize(CONFIG.PF2E.rarityTraits?.[rarity] ?? rarity);
        tags.push(`<span class="tag rarity ${esc(rarity)}">${esc(label)}</span>`);
    }
    for (const t of traits) {
        const tip = t.description ? ` data-tooltip="${esc(t.description)}"` : "";
        tags.push(`<span class="tag"${tip}>${esc(t.label)}</span>`);
    }
    return `<section class="tags paizo-style" data-tooltip-class="pf2e">${tags.join("")}</section>`;
}

function itemTraits(item) {
    if (typeof item.traitChatData === "function") {
        try {
            return item.traitChatData();
        } catch {
            /* fall through */
        }
    }
    return (item.system.traits?.value ?? []).map((t) => ({ label: t }));
}

/** Rows of [label, value] pairs; each inner array is printed on one line. */
function propertyLines(lines) {
    const out = lines
        .map((line) => line.filter(([, value]) => value !== null && value !== undefined && value !== ""))
        .filter((line) => line.length)
        .map((line) => `<p>${line.map(([label, value]) => `<strong>${esc(label)}</strong> ${value}`).join("; ")}</p>`);
    return out.join("");
}

function sourceLine(doc) {
    const title = doc.system.publication?.title || doc.system.details?.publication?.title;
    return title ? [[L("Source"), esc(title)]] : [];
}

async function itemCard(item) {
    const sys = item.system;
    let kind = game.i18n.localize(`TYPES.Item.${item.type}`);
    let level = item.level ?? sys.level?.value ?? null;
    let glyph = null;
    const lines = [sourceLine(item)];

    switch (item.type) {
        case "spell": {
            kind = item.isRitual ? L("Ritual") : item.isCantrip ? L("Cantrip") : item.isFocusSpell ? L("Focus") : L("Spell");
            level = item.rank;
            glyph = item.actionGlyph;
            const traditions = (sys.traits?.traditions ?? [])
                .map((t) => game.i18n.localize(CONFIG.PF2E.magicTraditions?.[t] ?? t))
                .join(", ");
            const duration = sys.duration?.value
                ? esc(sys.duration.value) + (sys.duration.sustained ? ` (${esc(L("Sustained"))})` : "")
                : sys.duration?.sustained
                  ? esc(L("Sustained"))
                  : null;
            lines.push(
                [[L("Traditions"), esc(traditions)]],
                [[L("Cast"), glyph ? null : esc(sys.time?.value)], [L("Cost"), esc(sys.cost?.value)]],
                [[L("Requirements"), esc(sys.requirements)]],
                [
                    [L("Range"), esc(sys.range?.value)],
                    [L("Area"), esc(item.area?.label)],
                    [L("Targets"), esc(sys.target?.value)],
                ],
                [
                    [L("Defense"), esc(item.defense?.label)],
                    [L("Duration"), duration],
                ],
            );
            break;
        }
        case "feat":
        case "action": {
            glyph = item.actionGlyph ?? null;
            if (item.type === "action") level = null;
            const prereqs = (sys.prerequisites?.value ?? []).map((p) => p.value).filter(Boolean);
            lines.push([[L("Prerequisites"), esc(prereqs.join("; "))]]);
            break;
        }
        default:
            if (item.isOfType?.("physical")) lines.push(...physicalLines(item));
    }

    const description = await enrich(item.description ?? sys.description?.value, item);

    return cardShell(
        header(item, { glyph, kind, level }),
        traitTags(sys.traits?.rarity, itemTraits(item)),
        propertyLines(lines),
        description,
    );
}

function physicalLines(item) {
    const sys = item.system;
    const price = item.price?.value?.toString?.();
    const bulk = item.bulk?.toString?.();
    const lines = [
        [
            [L("Price"), price && price !== "0 gp" ? esc(price) : null],
            [L("Bulk"), esc(bulk)],
        ],
        [[L("Usage"), sys.usage?.value ? esc(game.i18n.localize(CONFIG.PF2E.usages?.[sys.usage.value] ?? sys.usage.value)) : null]],
    ];

    if (item.type === "weapon") {
        const dmg = sys.damage;
        const type = dmg?.damageType ? game.i18n.localize(CONFIG.PF2E.damageTypes?.[dmg.damageType] ?? dmg.damageType) : "";
        const dice = dmg?.die ? `${dmg.dice ?? 1}${dmg.die} ${type}` : null;
        lines.push([
            [L("Damage"), esc(dice)],
            [L("Category"), sys.category ? esc(game.i18n.localize(CONFIG.PF2E.weaponCategories?.[sys.category] ?? sys.category)) : null],
            [L("Group"), sys.group ? esc(game.i18n.localize(CONFIG.PF2E.weaponGroups?.[sys.group] ?? sys.group)) : null],
        ]);
    } else if (item.type === "armor") {
        lines.push([
            [L("ACBonus"), sys.acBonus !== undefined ? esc(signed(sys.acBonus)) : null],
            [L("DexCap"), sys.dexCap !== null && sys.dexCap !== undefined ? esc(signed(sys.dexCap)) : null],
            [L("Strength"), sys.strength ? esc(signed(sys.strength)) : null],
        ]);
        lines.push([
            [L("CheckPenalty"), sys.checkPenalty ? esc(sys.checkPenalty) : null],
            [L("SpeedPenalty"), sys.speedPenalty ? `${esc(sys.speedPenalty)} ft.` : null],
        ]);
    } else if (item.type === "shield") {
        lines.push([
            [L("ACBonus"), sys.acBonus !== undefined ? esc(signed(sys.acBonus)) : null],
            [L("Hardness"), esc(sys.hardness)],
            [L("HP"), esc(sys.hp?.max)],
            [L("BT"), esc(sys.hp?.brokenThreshold)],
        ]);
    }
    return lines;
}

async function actorCard(actor) {
    const sys = actor.system;
    const kind =
        actor.type === "npc" ? L("Creature") : actor.type === "hazard" ? L("Hazard") : game.i18n.localize(`TYPES.Actor.${actor.type}`);
    const level = actor.level ?? sys.details?.level?.value ?? null;

    const traitDict = actor.type === "hazard" ? CONFIG.PF2E.hazardTraits : CONFIG.PF2E.creatureTraits;
    const traits = (sys.traits?.value ?? []).map((t) => ({ label: game.i18n.localize(traitDict?.[t] ?? t) }));
    if (sys.traits?.size?.value && actor.type === "npc") {
        const size = game.i18n.localize(CONFIG.PF2E.actorSizes?.[sys.traits.size.value] ?? sys.traits.size.value);
        traits.unshift({ label: size });
    }

    const mod = (stat) => (typeof stat?.mod === "number" ? esc(signed(stat.mod)) : null);
    const lines = [sourceLine(actor)];
    if (actor.type === "hazard") {
        lines.push([[L("Stealth"), mod(actor.skills?.stealth)]]);
    } else {
        lines.push([[L("Perception"), mod(actor.perception)]]);
    }
    lines.push(
        [
            [L("AC"), esc(sys.attributes?.ac?.value)],
            [L("Fort"), mod(actor.saves?.fortitude)],
            [L("Ref"), mod(actor.saves?.reflex)],
            [L("Will"), mod(actor.saves?.will)],
        ],
        [
            [L("HP"), esc(sys.attributes?.hp?.max || null)],
            [L("Hardness"), sys.attributes?.hardness ? esc(sys.attributes.hardness) : null],
        ],
    );

    const text = actor.type === "hazard" ? sys.details?.description : sys.details?.publicNotes;
    const description = await enrich(text, actor);

    return cardShell(header(actor, { kind, level }), traitTags(sys.traits?.rarity, traits), propertyLines(lines), description);
}

/* -------------------------------------------- */
/*  Init                                        */
/* -------------------------------------------- */

Hooks.once("init", registerSettings);
Hooks.once("ready", activateListeners);
