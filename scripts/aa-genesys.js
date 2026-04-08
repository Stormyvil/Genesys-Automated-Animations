const MODULE_ID = "aa-genesys";
const AA_ID     = "autoanimations";
const SYSTEM_ID = "genesys";
const PENDING_TTL_MS = 30_000;

function getSetting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return undefined;
  }
}

function log(...args) {
  if (getSetting("debug")) {
    console.log(`%c[AA-Genesys]`, "color:#7ec8e3;font-weight:bold", ...args);
  }
}

function warn(...args) {
  console.warn(`[AA-Genesys]`, ...args);
}

function parseContent(htmlContent) {
  const el = document.createElement("div");
  el.innerHTML = htmlContent;
  return el;
}

function isGenesysRoll(root) {
  return root.querySelector(".roll.roll-skill") !== null;
}

function extractAttackWeaponName(root) {
  const hasDamageIcon =
    root.querySelector(".fa-face-head-bandage, .fa-explosion") !== null;
  const hasQualitiesBlock =
    root.querySelector(".qualities") !== null;

  if (!hasDamageIcon && !hasQualitiesBlock) {
    return null;
  }
  const descEl = root.querySelector(".roll-description");
  if (!descEl) return null;

  const firstStrong = descEl.querySelector("strong");
  return firstStrong ? firstStrong.textContent.trim() : null;
}

function hasNetSuccess(root) {
  const netResults = root.querySelector(".net-results");
  if (!netResults) return false;
  for (const span of netResults.querySelectorAll("span")) {
    const t = span.textContent.trim();
    if (t === "s" || t === "t") return true;
  }
  return false;
}

function isInitiativeRoll(root) {
  const descEl = root.querySelector(".roll-description");
  if (!descEl) return false;
  return descEl.textContent.toLowerCase().includes("initiative");
}

function _weaponInItems(items, weaponName) {
  const weaponTypes = ["weapon", "vehicleWeapon"];
  const lower = weaponName.toLowerCase();
  return (
    items.find((i) => weaponTypes.includes(i.type) && i.name === weaponName) ??
    items.find((i) => weaponTypes.includes(i.type) && i.name.toLowerCase() === lower) ??
    null
  );
}

function findWeapon(speakerActor, weaponName, sourceToken) {
  if (!weaponName) return null;

  const seenActorIds = new Set();
  if (sourceToken?.actor) {
    const tokenActor = sourceToken.actor;
    seenActorIds.add(tokenActor.id);
    const item = _weaponInItems(tokenActor.items, weaponName);
    if (item) return { item, sourceActor: tokenActor };
  }

  if (speakerActor && !seenActorIds.has(speakerActor.id)) {
    seenActorIds.add(speakerActor.id);
    const item = _weaponInItems(speakerActor.items, weaponName);
    if (item) return { item, sourceActor: speakerActor };
  }

  for (const token of canvas?.tokens?.placeables ?? []) {
    const tokenActor = token.actor;
    if (!tokenActor || seenActorIds.has(tokenActor.id)) continue;
    seenActorIds.add(tokenActor.id);
    const item = _weaponInItems(tokenActor.items, weaponName);
    if (item) return { item, sourceActor: tokenActor };
  }

  const worldItem = _weaponInItems(game.items, weaponName);
  if (worldItem) return { item: worldItem, sourceActor: null };

  return null;
}

function findSkillOnActor(actor, root) {
  if (!actor) return null;
  const descEl = root.querySelector(".roll-description");
  if (!descEl) return null;
  const firstStrong = descEl.querySelector("strong");
  if (!firstStrong) return null;

  const skillName = firstStrong.textContent.trim().split(" (")[0].trim();
  if (!skillName) return null;

  return (
    actor.items.find((i) => i.type === "skill" && i.name === skillName) ??
    actor.items.find(
      (i) =>
        i.type === "skill" &&
        i.name.toLowerCase() === skillName.toLowerCase()
    ) ??
    null
  );
}

function resolveSourceToken(speaker) {
  if (!speaker) return null;

  const actorId = speaker.actor;

  if (speaker.token) {
    const tokenDoc = canvas?.scene?.tokens?.get(speaker.token);
    if (tokenDoc) {
      log("resolveSourceToken: via speaker.token →", tokenDoc.name);
      return tokenDoc.object ?? null;
    }
  }

  if (!actorId) return null;

  for (const t of canvas?.tokens?.controlled ?? []) {
    if (t.actor?.id === actorId) {
      log("resolveSourceToken: via controlled token →", t.name);
      return t;
    }
  }
  const openApps = [
    ...Object.values(ui.windows ?? {}),
    ...(foundry?.applications?.instances
      ? [...foundry.applications.instances.values()]
      : []),
  ];
  for (const app of openApps) {
    const sheetActor = app.actor ?? app.document;
    if (sheetActor?.documentName !== "Actor") continue;
    const appTokenDoc = app.token ?? sheetActor.token;
    if (appTokenDoc) {
      if (appTokenDoc.actor?.id === actorId || appTokenDoc.actorId === actorId) {
        const canvasToken = appTokenDoc.object ?? canvas?.tokens?.get(appTokenDoc.id);
        if (canvasToken) {
          log("resolveSourceToken: via open sheet (token) →", canvasToken.name);
          return canvasToken;
        }
      }
      continue; 
    }

    if (sheetActor.id === actorId) {
      const tokenFromSheet =
        sheetActor.token?.object ??
        canvas?.tokens?.placeables?.find((t) => t.actor?.id === actorId) ??
        null;
      if (tokenFromSheet) {
        log("resolveSourceToken: via open sheet (actor) →", tokenFromSheet.name);
        return tokenFromSheet;
      }
    }
  }

  const fallback =
    canvas?.tokens?.placeables?.find((t) => t.actor?.id === actorId) ?? null;
  if (fallback) {
    log("resolveSourceToken: via first-match fallback (may be wrong for multiple unlinked tokens) →", fallback.name);
  }
  return fallback;
}

function actorFromSpeaker(speaker, resolvedToken) {
  if (resolvedToken?.actor) return resolvedToken.actor;

  if (!speaker) return null;

  if (speaker.token) {
    const tokenDoc = canvas?.scene?.tokens?.get(speaker.token);
    if (tokenDoc?.actor) return tokenDoc.actor;
  }
  if (speaker.actor) {
    return game.actors.get(speaker.actor) ?? null;
  }

  return null;
}

async function dispatchAnimation(msg, item, sourceToken) {
  if (!item) {
    log("dispatchAnimation: no item, aborting");
    return;
  }

  const AA = window.AutomatedAnimations;
  if (!AA?.playAnimation) {
    warn("window.AutomatedAnimations.playAnimation not found — is AA active and initialised?");
    return;
  }

  const targets = Array.from(game.user.targets);
  log(
    "dispatchAnimation →", item.name,
    "| token:", sourceToken?.name ?? "none",
    "| targets:", targets.length,
  );

  try {
    await AA.playAnimation(sourceToken ?? null, item, { targets, workflow: msg });
  } catch (err) {
    warn("playAnimation threw:", err);
  }
}
function stash(pending, msgDoc, item, sourceToken, rollType) {
  const key = `${Date.now()}-${Math.random()}`;

  const timer = setTimeout(() => {
    if (pending.has(key)) {
      log(`stash TTL: discarding unmatched entry for "${item.name}" (key ${key})`);
      pending.delete(key);
    }
  }, PENDING_TTL_MS);

  pending.set(key, { item, sourceToken, timer });

  msgDoc.updateSource({
    [`flags.${MODULE_ID}.pendingKey`]: key,
    [`flags.${MODULE_ID}.rollType`]: rollType,
  });
}


Hooks.once("init", () => {
  if (game.system.id !== SYSTEM_ID) return;

  game.settings.register(MODULE_ID, "triggerOnAttack", {
    name: "AAGENESYS.Settings.TriggerOnAttack.Name",
    hint: "AAGENESYS.Settings.TriggerOnAttack.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "triggerOnSkill", {
    name: "AAGENESYS.Settings.TriggerOnSkill.Name",
    hint: "AAGENESYS.Settings.TriggerOnSkill.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "requireSuccess", {
    name: "AAGENESYS.Settings.RequireSuccess.Name",
    hint: "AAGENESYS.Settings.RequireSuccess.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "debug", {
    name: "AAGENESYS.Settings.Debug.Name",
    hint: "AAGENESYS.Settings.Debug.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
});

Hooks.once("ready", () => {
  if (game.system.id !== SYSTEM_ID) return;

  if (!game.modules.get(AA_ID)?.active) {
    ui.notifications.warn(game.i18n.localize("AAGENESYS.Notifications.AANotFound"));
    warn("Automated Animations not found or inactive — module will not function.");
    return;
  }

  log("Ready.");

  const pending = new Map();

  Hooks.on("preCreateChatMessage", (msgDoc, data, _options, userId) => {

    if (userId !== game.user.id) return;

    const content = data.content ?? "";
    if (!content) return;

    const root = parseContent(content);

    if (!isGenesysRoll(root)) return;

    if (isInitiativeRoll(root)) {
      log("preCreateChatMessage: initiative roll — skipping");
      return;
    }
    const sourceToken = resolveSourceToken(data.speaker);
    const actor = actorFromSpeaker(data.speaker, sourceToken);
    if (!actor) {
      log("preCreateChatMessage: could not resolve actor from speaker", data.speaker);
      return;
    }
    if (getSetting("triggerOnAttack")) {
      const weaponName = extractAttackWeaponName(root);
      if (weaponName !== null) {
        log("preCreateChatMessage: attack roll, weapon:", weaponName);

        if (getSetting("requireSuccess") && !hasNetSuccess(root)) {
          log("preCreateChatMessage: no net success — skipping (requireSuccess=true)");
          return;
        }

        const found = findWeapon(actor, weaponName, sourceToken);
        if (found) {
          const ownerLabel = found.sourceActor
            ? (found.sourceActor.id === actor?.id ? "speaker actor" : `other actor: ${found.sourceActor.name}`)
            : "world items";
          log("preCreateChatMessage: matched item:", found.item.name, found.item.id, "— found on", ownerLabel);
          stash(pending, msgDoc, found.item, sourceToken, "attack");
        } else {
          log(
            "preCreateChatMessage: weapon not found anywhere for name:", weaponName,
            "— checked speaker actor, all canvas tokens, and world items",
          );
        }
        return;
      }
    }
    if (getSetting("triggerOnSkill")) {
      const skillItem = findSkillOnActor(actor, root);
      if (!skillItem) return;
      const hasAAConfig =
        skillItem.flags?.[AA_ID]?.menu &&
        skillItem.flags[AA_ID].menu !== "noAnimation";

      if (!hasAAConfig) {
        log("preCreateChatMessage: skill has no AA config — skipping:", skillItem.name);
        return;
      }

      log("preCreateChatMessage: skill roll:", skillItem.name);
      stash(pending, msgDoc, skillItem, sourceToken, "skill");
    }
  });

  Hooks.on("createChatMessage", async (msg, _options, userId) => {
    if (userId !== game.user.id) return;

    const key = msg.flags?.[MODULE_ID]?.pendingKey;
    if (!key) return;

    const entry = pending.get(key);
    if (!entry) {
      log("createChatMessage: no pending entry for key", key, "(already timed out?)");
      return;
    }

    clearTimeout(entry.timer);
    pending.delete(key);

    log("createChatMessage: dispatching animation for", entry.item?.name);
    await dispatchAnimation(msg, entry.item, entry.sourceToken);
  });
});
