// ═══════════════════════════════════════════════════
//  MONSTER IMAGE PRE-GENERATOR
//  Paste this entire script into your browser console
//  while logged into your game (so Firestore works).
//  It will generate + cache all 24 monster images.
// ═══════════════════════════════════════════════════

(async () => {

  // ── Config ──────────────────────────────────────
  const TOKEN = window._REPLICATE_TOKEN;
  if (!TOKEN || TOKEN === "PASTE_YOUR_NEW_TOKEN_HERE") {
    console.error("❌ No Replicate token found. Make sure your game page is loaded with the token set.");
    return;
  }

  const SDXL_VERSION = "ac732df83cea7fff18b8472768c88ad041fa750ff7682a21affe81863cbe77e4";

  // ── All 24 monsters with prompts ─────────────────
  const MONSTERS = [
    // E
    { name: "Goblin Scout",      grade: "E", prompt: "a small cunning goblin scout in ragged leather armor holding a rusty dagger, dark fantasy RPG portrait, dramatic rim lighting, highly detailed" },
    { name: "Weak Slime",        grade: "E", prompt: "a translucent green slime monster with glowing evil eyes, dark fantasy RPG portrait, dramatic lighting, highly detailed" },
    { name: "Forest Rat",        grade: "E", prompt: "a giant mutated forest rat with glowing red eyes and sharp claws, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Stray Imp",         grade: "E", prompt: "a small red imp demon with tiny wings and a mischievous grin, dark fantasy RPG portrait, dramatic lighting, highly detailed" },
    // D
    { name: "Cave Troll",        grade: "D", prompt: "a massive grey cave troll with mossy skin and a stone club, dark fantasy RPG portrait, dramatic lighting, highly detailed" },
    { name: "Bone Archer",       grade: "D", prompt: "an undead skeleton archer with a rotting longbow and tattered cloak, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Shadow Hound",      grade: "D", prompt: "a spectral shadow hound with glowing purple eyes made of living darkness, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Stone Golem Jr.",   grade: "D", prompt: "a small stone golem with glowing amber rune carvings, dark fantasy RPG portrait, dramatic lighting" },
    // C
    { name: "Iron Golem",        grade: "C", prompt: "a towering iron golem with steam vents and glowing amber eyes, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Dark Knight",       grade: "C", prompt: "a menacing dark knight in black spiked armor wielding a flamberge sword, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Blood Witch",       grade: "C", prompt: "a pale blood witch in crimson robes casting swirling dark blood magic, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Cursed Warrior",    grade: "C", prompt: "a cursed undead warrior with cracked dark armor and a tormented expression, dark fantasy RPG portrait, dramatic lighting" },
    // B
    { name: "Wyvern",            grade: "B", prompt: "a fierce wyvern with slate grey scales and a venomous barbed tail against a stormy sky, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Lich Mage",         grade: "B", prompt: "an ancient lich in tattered royal robes floating with crackling dark magic energy, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Abyssal Beast",     grade: "B", prompt: "a terrifying abyssal creature from the void with tentacles and many glowing eyes, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Storm Elemental",   grade: "B", prompt: "a swirling humanoid storm elemental made of lightning and thunderclouds, dark fantasy RPG portrait, dramatic lighting" },
    // A
    { name: "Elder Dragon",      grade: "A", prompt: "an ancient elder dragon with obsidian scales and eyes of molten gold, dark fantasy RPG portrait, dramatic lighting, epic scale" },
    { name: "Chaos Titan",       grade: "A", prompt: "a colossal chaos titan wreathed in crackling dark energy and destruction, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Void Stalker",      grade: "A", prompt: "a terrifying void stalker emerging from a dimensional rift with dark tendrils, dark fantasy RPG portrait, dramatic lighting" },
    { name: "Death Harbinger",   grade: "A", prompt: "a cloaked death harbinger wielding a scythe dripping dark necrotic energy, dark fantasy RPG portrait, dramatic lighting" },
    // S
    { name: "Ancient Leviathan", grade: "S", prompt: "an ancient cosmic sea leviathan of immense scale with reality breaking around it, dark fantasy RPG portrait, epic, dramatic lighting" },
    { name: "God Slayer",        grade: "S", prompt: "a divine god slayer warrior in celestial armor wielding a sword of pure light, dark fantasy RPG portrait, epic, dramatic lighting" },
    { name: "Eternal Lich",      grade: "S", prompt: "the eternal lich on a throne of bones wearing a crown of skulls, ultimate undead ruler, dark fantasy RPG portrait, dramatic lighting" },
    { name: "World Ender",       grade: "S", prompt: "the world ender, an eldritch cosmic horror that consumes reality itself, dark fantasy RPG portrait, epic, dramatic lighting" },
  ];

  // ── Firestore helpers (uses the already-loaded Firebase on the page) ──
  const { doc, getDoc, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const db = window._db || window.db;
  if (!db) {
    console.error("❌ Firestore db not found on window. Make sure you're running this on your game page.");
    return;
  }

  // ── Generate one monster ──────────────────────────
  async function generate(monster) {
    const slug = monster.name.replace(/\s+/g,"_").replace(/[^a-zA-Z0-9_]/g,"");
    const cacheRef = doc(db, "monsterImages", slug);

    // Check cache first
    const snap = await getDoc(cacheRef);
    if (snap.exists() && snap.data().url) {
      console.log(`✅ [${monster.grade}] ${monster.name} — already cached, skipping`);
      return;
    }

    console.log(`🎨 [${monster.grade}] ${monster.name} — generating...`);

    // Start prediction
    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Token ${TOKEN}`,
      },
      body: JSON.stringify({
        version: SDXL_VERSION,
        input: {
          prompt: monster.prompt,
          negative_prompt: "anime, cartoon, 3d render, text, watermark, blurry, deformed, ugly, low quality",
          width: 512,
          height: 512,
          num_inference_steps: 30,
          guidance_scale: 7.5,
        }
      })
    });

    if (!res.ok) {
      console.error(`❌ ${monster.name} — Replicate request failed:`, await res.text());
      return;
    }

    const pred = await res.json();

    // Poll until done
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, {
        headers: { "Authorization": `Token ${TOKEN}` }
      });
      const result = await poll.json();

      if (result.status === "succeeded" && result.output?.[0]) {
        const url = result.output[0];
        await setDoc(cacheRef, { url, name: monster.name, grade: monster.grade, generatedAt: new Date() });
        console.log(`✅ [${monster.grade}] ${monster.name} — saved! ${url}`);
        return;
      }

      if (result.status === "failed") {
        console.error(`❌ ${monster.name} — generation failed`);
        return;
      }

      console.log(`⏳ [${monster.grade}] ${monster.name} — waiting... (${(i+1)*2}s)`);
    }

    console.error(`❌ ${monster.name} — timed out after 80s`);
  }

  // ── Run all 24 sequentially (avoids rate limits) ──
  console.log("🚀 Starting pre-generation for all 24 monsters...");
  console.log("⏱️  This will take roughly 5-10 minutes total. Don't close this tab.\n");

  for (const monster of MONSTERS) {
    await generate(monster);
  }

  console.log("\n🎉 All done! All monster images are cached in Firestore.");
  console.log("Players will now see images instantly on first encounter.");

})();