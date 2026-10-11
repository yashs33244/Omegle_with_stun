/**
 * Phrase lists for the safety guard (src/safety/guard.ts). Data only, covered
 * by test/unit/guard.test.ts. Matching normalizes case, common leetspeak and
 * repeated letters, so list each phrase once in plain lowercase.
 *
 * These lists drive informative nudges and display-name replacement only.
 * They never ban or penalize anyone on their own, so false positives cost a
 * nudge, not an account. Keep them short and add phrases from real reports.
 */

/**
 * Messaging apps people use to move a stranger off the platform. Matched as
 * whole words. A following word is treated as a handle ("insta priya_k",
 * "my snapchat is rahul").
 */
export const STRONG_PLATFORMS = [
  "snapchat",
  "insta",
  "instagram",
  "kik",
  "discord",
  "skype",
  "wechat",
  "tiktok",
  "facebook",
  "इंस्टा",
  "इंस्टाग्राम",
  "स्नैपचैट",
] as const;

/**
 * Short or ambiguous names ("ig" is also "I guess"). The next word counts as a
 * handle only after an explicit ":", "=", "-" or "@", or when it looks like a
 * handle (has a digit, "_" or ".").
 */
export const WEAK_PLATFORMS = ["snap", "sc", "ig", "tg", "wa", "fb", "स्नैप"] as const;

/** Platforms whose bare mention is already contact sharing and is hidden ("add me on whatsapp"). */
export const ALWAYS_CONTACT_PLATFORMS = [
  "telegram",
  "whatsapp",
  "whatsap",
  "watsapp",
  "onlyfans",
  "व्हाट्सएप",
  "व्हाट्सऐप",
  "टेलीग्राम",
] as const;

/** Words allowed between a platform and the handle: "my insta id is priya". */
export const HANDLE_CONNECTORS = [
  "id",
  "handle",
  "username",
  "user",
  "name",
  "is",
  "pe",
  "par",
  "on",
  "me",
  "mein",
  "hai",
  "h",
] as const;

/** Words after a platform that are never a handle ("insta account hai?"). */
export const NOT_HANDLES = [
  "account",
  "acc",
  "story",
  "stories",
  "reel",
  "reels",
  "post",
  "posts",
  "and",
  "or",
  "but",
  "the",
  "to",
  "se",
  "ka",
  "ki",
  "ke",
  "ho",
  "bhi",
  "nahi",
  "no",
  "yes",
  "ok",
  "kya",
  "pr",
  "chalate",
  "use",
  "app",
] as const;

/** Link hosts that are contact sharing, not just links. */
export const SOCIAL_HOSTS = [
  "instagram.com",
  "snapchat.com",
  "t.me",
  "telegram.me",
  "wa.me",
  "whatsapp.com",
  "facebook.com",
  "fb.com",
  "m.me",
  "tiktok.com",
  "discord.gg",
  "discord.com",
  "onlyfans.com",
] as const;

/** Phrases that invite moving the chat elsewhere, in EN, HI and Hinglish. */
export const CONTACT_PHRASES = [
  "add me on",
  "dm me",
  "text me",
  "call me on",
  "my number",
  "your number",
  "ur number",
  "number do",
  "number de do",
  "number bhejo",
  "apna number",
  "mera number",
  "id do",
  "id bhejo",
  "apni id",
  "नंबर दो",
  "अपना नंबर",
  "मेरा नंबर",
] as const;

/**
 * Sexual solicitation and sextortion openers, EN, HI (Devanagari) and Hinglish.
 * Matched as whole-word phrases after normalization.
 */
export const SOLICITATION_PHRASES = [
  // English
  "show me your body",
  "show your body",
  "show me ur body",
  "show ur body",
  "show me your boobs",
  "show your boobs",
  "show boobs",
  "show tits",
  "show your tits",
  "show dick",
  "show your dick",
  "remove your shirt",
  "remove shirt",
  "remove your top",
  "remove your clothes",
  "take off your shirt",
  "take off your top",
  "take off your clothes",
  "take off ur",
  "strip for me",
  "get naked",
  "send nudes",
  "send nude",
  "nudes",
  "nude pics",
  "private show",
  "cam show",
  "paid show",
  "i will pay you",
  "i'll pay you",
  "pay you for",
  "are you alone",
  "r u alone",
  "sexy video",
  "sex chat",
  "sexting",
  "touch yourself",
  // Hinglish
  "kapde utaro",
  "kapde utar",
  "kapde nikalo",
  "shirt utaro",
  "shirt utar",
  "top utaro",
  "body dikhao",
  "boobs dikhao",
  "kuch dikhao",
  "sab dikhao",
  "nangi",
  "nanga",
  "nangi ho ja",
  "paise dunga",
  "paisa dunga",
  "paise dungi",
  "akeli ho",
  "akele ho",
  "ghar pe akeli",
  "sexy baat",
  "gandi baat",
  // Hindi (Devanagari)
  "कपड़े उतारो",
  "कपडे उतारो",
  "शर्ट उतारो",
  "नंगी",
  "नंगा",
  "बॉडी दिखाओ",
  "कुछ दिखाओ",
  "पैसे दूंगा",
  "अकेली हो",
] as const;

/**
 * Display-name slurs, EN, HI and Hinglish. Short words (4 letters or fewer) must
 * match a whole word; longer ones also match inside a word ("xxchutiyaxx").
 * Words that collide with common given names (for example "randi") are left
 * out in Latin script on purpose.
 */
export const NAME_SLURS = [
  "nigger",
  "nigga",
  "faggot",
  "fag",
  "retard",
  "chink",
  "paki",
  "kike",
  "spic",
  "tranny",
  "whore",
  "slut",
  "cunt",
  "rapist",
  "pedo",
  "chutiya",
  "chutiye",
  "madarchod",
  "maderchod",
  "behenchod",
  "bhenchod",
  "bhosdike",
  "bhosdi",
  "gandu",
  "harami",
  "katua",
  "chamar",
  "bhangi",
  "चूतिया",
  "मादरचोद",
  "भेनचोद",
  "बहनचोद",
  "रंडी",
  "गांडू",
  "हरामी",
] as const;

/** Slurs that are also substrings of ordinary words; matched as whole words only. */
export const WORD_ONLY_SLURS = ["rapist", "chamar"] as const;
