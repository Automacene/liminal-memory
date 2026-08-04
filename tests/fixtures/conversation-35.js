/**
 * Test fixture: 50 message pairs (100 messages total → 50 turn nodes).
 * With windowSize=20, nodes 1-30 will be outside the window.
 * Topics drift across 5 distinct subjects to test recall across topic boundaries.
 * 
 * Topic map:
 *   Turns 1-10:   Python/BM25 coding (early, will be outside window)
 *   Turns 11-18:  Dogs/pets (middle, partially outside window)
 *   Turns 19-26:  Tokyo travel (middle, partially in window depending on config)
 *   Turns 27-35:  Music production (recent-ish)
 *   Turns 36-50:  Building a PC + random life stuff (most recent, in window)
 * 
 * Key recall targets (things to search for that are OUTSIDE window):
 *   - "ModuleNotFoundError" (turn 2)
 *   - "Biscuit" the corgi (turn 11)
 *   - "Ulaanbaatar" Mongolia (turn 13)
 *   - "cherry blossom" Tokyo (turn 15)
 *   - k1=1.2 b=0.4 BM25 params (turn 9)
 *   - Secret code word "pineapple" (turn 7) — needle in a haystack test
 */
var conversation35 = [
  // === TURNS 1-10: Python/BM25 coding ===
  { role: "user", content: "hey, im working on a python project and i keep getting an import error" },
  { role: "assistant", content: "Hey! Import errors are usually one of a few things — wrong module name, missing install, or a path issue. Can you paste the exact error message?" },
  { role: "user", content: "it says ModuleNotFoundError: No module named 'bm25s'" },
  { role: "assistant", content: "You need to install it. Run: pip install bm25s. If you're using a virtual environment, make sure it's activated first." },
  { role: "user", content: "oh wait i think im not in my venv, how do i activate it on windows" },
  { role: "assistant", content: "Navigate to your project folder, then run: .\\venv\\Scripts\\activate. You should see (venv) appear at the start of your terminal prompt." },
  { role: "user", content: "that fixed it! okay now bm25s is installed. hey totally random but i want to set a secret code word for our conversation so i can test memory later. the code word is pineapple." },
  { role: "assistant", content: "Got it — the secret code word is pineapple. I'll remember that. Now, what do you want to do with bm25s?" },
  { role: "user", content: "TypeError: expected list of lists, got list of str — thats what i get when indexing" },
  { role: "assistant", content: "bm25s expects pre-tokenized documents. Instead of passing ['hello world', 'foo bar'], you need [['hello', 'world'], ['foo', 'bar']]. Just do: tokenized = [doc.split() for doc in documents]" },
  { role: "user", content: "that fixed it! now how do i get the top 3 results with scores?" },
  { role: "assistant", content: "Use: results, scores = retriever.retrieve(bm25s.tokenize(query), k=3, return_as='tuple'). The scores array has the BM25 score for each result in order." },
  { role: "user", content: "perfect. what k1 and b values should i use for short chat messages?" },
  { role: "assistant", content: "For short conversational text, try k1=1.2 and b=0.4. The lower b reduces length normalization penalty since chat messages are all roughly the same short length." },
  { role: "user", content: "makes sense. and the default is k1=1.5 b=0.75 right?" },
  { role: "assistant", content: "Close — most common defaults are k1=1.2 to 2.0 and b=0.75. k1 controls term frequency saturation, b controls length normalization." },
  { role: "user", content: "got it. also my project folder is at C:\\Users\\dev\\projects\\memory-engine in case i need to reference it later" },
  { role: "assistant", content: "Noted — your project is at C:\\Users\\dev\\projects\\memory-engine. Let me know whenever you need help with it." },
  { role: "user", content: "cool. i think the version of python im using is 3.11.4 if that matters" },
  { role: "assistant", content: "3.11.4 is solid — good performance improvements over 3.10 and full support for modern typing features. No compatibility issues with bm25s on that version." },
  // === TURNS 11-18: Dogs/pets ===
  { role: "user", content: "okay totally different topic. my friend has a corgi named Biscuit and he literally herds the cats in the house. im thinking about getting a dog too" },
  { role: "assistant", content: "Corgis are amazing apartment dogs — small body, huge personality, surprisingly athletic. They shed a LOT though. Biscuit sounds hilarious with the cat herding. What kind of living space do you have?" },
  { role: "user", content: "700 sq ft apartment. is that too small for a golden retriever?" },
  { role: "assistant", content: "It's tight but doable if you commit to daily walks — at least an hour of exercise. Many people in cities do it. A corgi would honestly be easier in that space though." },
  { role: "user", content: "hey random — whats the capital of mongolia? my friend was asking" },
  { role: "assistant", content: "Ulaanbaatar. Home to about half of Mongolia's population (~1.5 million). Extreme temps — -40°C winter to +35°C summer." },
  { role: "user", content: "damn thats cold. anyway back to dogs — i think im gonna go with a corgi. any good name suggestions?" },
  { role: "assistant", content: "Some corgi names: Mochi, Nugget, Potato, Waffles, Dumpling, Sir Barksalot. Or regal ones since they're the Queen's breed: Winston, Chester, Pembroke." },
  { role: "user", content: "okay i decided. his name is going to be Mochi. short, snappy, food themed for a chunky boy" },
  { role: "assistant", content: "Perfect choice. Mochi is easy to call at the dog park and matches the round corgi energy. Congrats on the future pup!" },
  { role: "user", content: "the breeder says Mochi will be ready to pick up on March 15th" },
  { role: "assistant", content: "March 15th — exciting! That gives you a few weeks to puppy-proof the apartment. Get a crate, some chew toys, and a good enzymatic cleaner for accidents." },
  { role: "user", content: "what food brand do you recommend for corgi puppies?" },
  { role: "assistant", content: "Royal Canin has a specific medium puppy formula that works well for corgis. Blue Buffalo Life Protection is another solid option. Avoid grain-free diets for puppies — recent studies link them to heart issues." },
  { role: "user", content: "good to know. also my vet's name is Dr. Nakamura at the Hillside Animal Clinic on 4th street" },
  { role: "assistant", content: "Got it — Dr. Nakamura, Hillside Animal Clinic, 4th street. Good to have that on record for puppy checkups." },
  // === TURNS 19-26: Tokyo travel ===
  { role: "user", content: "switching gears — im thinking about going to tokyo next spring for cherry blossom season" },
  { role: "assistant", content: "Amazing timing! Late March through mid-April is peak season. Book hotels 3-4 months ahead — prices spike and everything fills up. Ueno Park and Meguro River are the best spots for blossoms." },
  { role: "user", content: "what about getting around the city? i dont speak japanese" },
  { role: "assistant", content: "Get a Suica card — works on all trains and buses, tap-and-go. The Tokyo Metro app has English maps. Most stations have English signage. Google Maps works perfectly for navigation there." },
  { role: "user", content: "whats the food situation? im vegetarian" },
  { role: "assistant", content: "Vegetarian in Tokyo is tricky — dashi (fish broth) is in almost everything. Look for shojin ryori (Buddhist temple cuisine) which is fully vegan. T's TanTan in Tokyo Station is a famous vegan ramen spot. HappyCow app helps find options." },
  { role: "user", content: "nice. budget wise, how much should i plan for per day?" },
  { role: "assistant", content: "Budget about ¥10,000-15,000/day ($70-100 USD) for food + transport + activities, not counting hotel. You can eat well for ¥1,000-2,000 per meal at local spots. Train passes help if you're doing day trips." },
  { role: "user", content: "my flight is booked — March 28 to April 8. ANA airlines, flight NH109" },
  { role: "assistant", content: "Nice — ANA is excellent. That's 11 nights which is a great length for Tokyo. You'll catch peak cherry blossom timing around March 30 - April 5 based on historical bloom dates." },
  { role: "user", content: "should i get a japan rail pass or just use suica?" },
  { role: "assistant", content: "If you're staying in Tokyo only, just Suica. The JR Pass is only worth it if you're doing bullet train trips to Kyoto, Osaka, etc. For Tokyo-only, individual rides on Suica are cheaper." },
  { role: "user", content: "what about pocket wifi vs sim card?" },
  { role: "assistant", content: "Pocket wifi if you're traveling with someone (share one device). eSIM if your phone supports it — Ubigi or Airalo work great in Japan, ~$15 for 2 weeks. Way simpler than physical SIM swaps." },
  { role: "user", content: "cool ill go with airalo esim then. last japan question — any areas to avoid staying in?" },
  { role: "assistant", content: "Avoid Roppongi if you want sleep — it's the nightlife district. Kabukicho in Shinjuku can be sketchy late at night. Best areas to stay: Shibuya, Shinjuku (west side), Asakusa for traditional vibes, or Nakano for quiet + good transit." },
  // === TURNS 27-35: Music production ===
  { role: "user", content: "totally new topic — i want to get into music production. where do i even start?" },
  { role: "assistant", content: "Start with a DAW (Digital Audio Workstation). Free options: GarageBand (Mac), Cakewalk (Windows). Paid: Ableton Live, FL Studio, Logic Pro. FL Studio is great for beginners — visual workflow, lots of tutorials online." },
  { role: "user", content: "i have windows so ill try FL Studio. do i need any hardware?" },
  { role: "assistant", content: "For starting: just headphones (Audio-Technica ATH-M50x are the standard) and maybe a basic MIDI keyboard (Akai MPK Mini ~$60). Don't buy studio monitors until you know you're serious — headphones are fine for learning." },
  { role: "user", content: "what genre would be easiest to start with as a complete beginner?" },
  { role: "assistant", content: "Lo-fi hip hop or basic trap beats. Simple structures (4-8 bar loops), not many layers needed, tons of free drum kits and samples available. You can make something that sounds decent in an afternoon." },
  { role: "user", content: "what BPM is lo-fi usually at?" },
  { role: "assistant", content: "70-90 BPM typically. The slower tempo gives it that relaxed, head-nodding feel. Start at 80 BPM — it's the sweet spot for that classic lo-fi vibe." },
  { role: "user", content: "and trap?" },
  { role: "assistant", content: "130-170 BPM for trap, with 140 being the most common. The hi-hats are usually double or triple time which makes it feel faster than it actually is." },
  { role: "user", content: "whats the difference between mixing and mastering?" },
  { role: "assistant", content: "Mixing: balancing individual tracks (EQ, compression, panning, effects) so they sound good together. Mastering: final polish on the mixed-down stereo file (loudness, final EQ, stereo width) so it sounds good on all speakers. Mix first, master last." },
  { role: "user", content: "makes sense. what about sampling? is it legal to sample other songs?" },
  { role: "assistant", content: "Legally: you need permission (sample clearance) to use recognizable parts of copyrighted songs commercially. For learning/non-commercial: nobody's going to sue a bedroom producer. Use royalty-free sample packs (Splice, Looperman) to stay safe." },
  { role: "user", content: "i signed up for Splice. my username is beatmaker_mochi (named after my future corgi lol)" },
  { role: "assistant", content: "Ha! Love it — beatmaker_mochi. Full circle from the dog conversation. Splice is the best investment for production. The 100 credits/month plan gives you tons of one-shots and loops to work with." },
  { role: "user", content: "my audio interface just arrived — its a Focusrite Scarlett 2i2 4th gen" },
  { role: "assistant", content: "Excellent choice — the Scarlett 2i2 is the industry standard entry-level interface. Low latency, clean preamps, works with everything. Make sure to install the Focusrite Control software for best performance." },
  // === TURNS 36-50: PC build + random life stuff ===
  { role: "user", content: "okay different thing entirely — my computer is getting slow and i want to build a new PC for music production and some gaming" },
  { role: "assistant", content: "Great project. For music production + gaming you want: fast single-core CPU (Intel i7 or Ryzen 7), 32GB RAM minimum (DAWs eat memory), fast NVMe SSD for sample libraries, and a decent GPU for gaming. What's your budget?" },
  { role: "user", content: "around $1500 not counting monitor. what CPU should i get?" },
  { role: "assistant", content: "At $1500: AMD Ryzen 7 7800X3D if you prioritize gaming, or Intel i7-14700K if you want more cores for production workloads. Both are excellent. The Ryzen runs cooler and uses less power." },
  { role: "user", content: "ill go ryzen. what motherboard pairs with that?" },
  { role: "assistant", content: "For the 7800X3D: MSI MAG B650 TOMAHAWK or ASUS TUF GAMING B650-PLUS. Both are solid mid-range boards with good VRM, WiFi 6, and plenty of USB ports for audio interfaces and MIDI controllers." },
  { role: "user", content: "what about RAM? does speed matter for music production?" },
  { role: "assistant", content: "Yes — get DDR5-6000 CL30 (the sweet spot for AM5 platform). 32GB (2x16GB) is perfect. G.Skill Flare X5 or Corsair Vengeance are reliable. DDR5-6000 hits the infinity fabric sweet spot on Ryzen 7000." },
  { role: "user", content: "GPU recommendations? i play some games but nothing super demanding. mostly valorant and some single player stuff" },
  { role: "assistant", content: "RTX 4060 Ti ($350-400) handles everything at 1080p/1440p easily. For Valorant you'd get 200+ FPS. If you want future-proofing, RTX 4070 ($500) gives you solid 1440p for years. Both have NVENC for streaming if you ever want to." },
  { role: "user", content: "4060 Ti sounds good. storage — how much do i need for sample libraries?" },
  { role: "assistant", content: "1TB NVMe for OS + DAW + active projects, then a 2TB SATA SSD for sample libraries. Splice alone can eat 100GB+ easily. Kontakt libraries are massive (some are 50-100GB each). 2TB secondary is the move." },
  { role: "user", content: "what case should i get? i want good airflow but nothing too flashy" },
  { role: "assistant", content: "Fractal Design Meshify 2 Compact — excellent airflow mesh front, clean look, great cable management, quiet. No RGB nonsense unless you add it. It's the go-to for 'function over form' builders." },
  { role: "user", content: "and PSU? i always hear thats the one thing not to cheap out on" },
  { role: "assistant", content: "Correct — never cheap out on PSU. Corsair RM750x or Seasonic Focus GX-750. Both are 80+ Gold, fully modular, 10-year warranty. 750W is plenty for your build with room for upgrades." },
  { role: "user", content: "awesome. im ordering everything from microcenter this weekend. my local one is on Tustin Ave" },
  { role: "assistant", content: "Microcenter Tustin — nice, that's one of the bigger locations. Check their CPU+motherboard combo deals, they usually knock $20-50 off when you buy together. Also their open-box GPUs are legit." },
  { role: "user", content: "oh hey one more thing — my wifi password at home is Mochi2024Bark in case i need to set up the new PC remotely" },
  { role: "assistant", content: "Got it — wifi password is Mochi2024Bark. I'd recommend not sharing passwords in chat history long-term, but noted for your setup. When you're ready to build, I can walk you through the assembly step by step." },
  { role: "user", content: "thanks dude. this has been a wild conversation — python coding, dogs, tokyo, music, and now PC building all in one session" },
  { role: "assistant", content: "That's what I'm here for — one-stop shop for whatever's on your mind. You've got a solid plan across all fronts: Mochi the corgi in March, Tokyo in late March, music production setup, and a beastly PC build this weekend. Let me know when any of it kicks off!" },
  { role: "user", content: "will do. catch you later" },
  { role: "assistant", content: "Later! Good luck with the build this weekend. And remember — pineapple." }
];

// ES module export (for Node.js tests using import syntax)
export { conversation35 };
