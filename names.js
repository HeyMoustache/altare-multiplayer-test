/* Fortune's Gambit: player-name filter (v2.37).
   The SAME file runs on the duel server (which has the final say) and in the game (which
   warns you before you send a name). Keep both copies identical, like rules.js.

   How it checks a name:
   1. Lower-case it and undo common disguises: 0→o 1→i 3→e 4→a 5→s 7→t @→a $→s, etc.
   2. Squash it: drop spaces, dots, dashes and other symbols ("f.u.c.k"), and repeated letters ("fuuuck").
   3. ROOTS are blocked anywhere inside the squashed name ("xXf.u.c.kXx"); short roots must match exactly,
      so ordinary names like "Knight" or "Cumbria" are never caught.
      WORDS are only blocked as whole words, so innocent names like "Cassandra",
      "Scunthorpe" or "Dickens" are fine. */

const ROOTS = [
  'fuck', 'fuk', 'fck', 'shit', 'cunt', 'bitch', 'bastard', 'wank', 'twat', 'bollock', 'bellend',
  'whore', 'slut', 'nigg', 'nigga', 'faggot', 'retard', 'spastic', 'rapist', 'raping', 'nazi',
  'hitler', 'porn', 'penis', 'vagina', 'pussy', 'dildo', 'jizz', 'motherf', 'asshole',
  'arsehole', 'tosser', 'minge',
];
const WORDS = [
  'ass', 'arse', 'cock', 'dick', 'prick', 'piss', 'tits', 'tit', 'boob', 'boobs', 'sex', 'fag',
  'paki', 'chink', 'kike', 'spic', 'coon', 'gook', 'wop', 'rape', 'nonce', 'knob', 'git', 'crap',
  'damn', 'hell', 'bum', 'poo', 'wtf', 'stfu', 'gtfo', 'cum', 'kkk',
];

// Real words and places that happen to contain a blocked root; they're removed before checking.
const ALLOWED = ['scunthorpe', 'shiitake', 'penistone', 'cockburn', 'hitchcock', 'peacock', 'cocktail', 'cockerel',
  'assassin', 'therapist', 'bassett', 'cassandra', 'sussex', 'essex', 'middlesex', 'dickens', 'dickinson', 'cumbria', 'cucumber', 'document'];

const LEET = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g', '6': 'g', '2': 'z' };
const unleet = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[0-9!|@$+]/g, (c) => LEET[c] || c);
const squash = (s) => s.replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');

/* True if the name should not be shown to other players. */
export function isRudeName(name) {
  const text = unleet(String(name || '')).replace(new RegExp(ALLOWED.join('|'), 'g'), ' ');
  const letters = text.replace(/[^a-z]/g, '');   // "f.u.c.k" -> "fuck"
  const squashed = squash(text);                 // and "fuuuck" -> "fuck"
  for (const r of ROOTS) {
    if (letters.includes(r)) return true;
    const sr = squash(r);                         // only trust the squashed match for longer roots,
    if (sr.length >= 4 && squashed.includes(sr)) return true; // so "knight" never matches "nig"
  }
  // Whole words: split on anything that isn't a letter (after undoing disguises).
  const words = text.split(/[^a-z]+/).filter(Boolean);
  return words.some((w) => [w, w.replace(/(.)\1+/g, '$1'), w.replace(/s$/, '')].some((x) => WORDS.includes(x)));
}

/* Tidy a name for display: no control characters or angle brackets, single spaces,
   at most 20 characters; a blank or rude name becomes the fallback. */
export function cleanPlayerName(name, fallback) {
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!clean || isRudeName(clean)) return fallback;
  return clean;
}
