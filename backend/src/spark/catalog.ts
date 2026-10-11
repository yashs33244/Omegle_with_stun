/**
 * Spark prompt catalog: the single source of truth for icebreakers.
 *
 * The server only needs ids and topics (SparkService). The clients need the
 * text in their own UI language, so `scripts/sync-spark-prompts.sh` generates
 * new-frontend/public/spark/prompts.<lang>.json from this file; CI fails if
 * the generated files drift. Edit here, run the script, commit both.
 *
 * Content rules (every line is reviewed against them): fun, answerable in
 * one breath, and safe for two strangers: no sexual, political or religious
 * bait, nothing that asks for contact details or location beyond "your city".
 */
import type { Topic } from "../protocol";

export interface SparkPrompt {
  /** `<topic>-<nn>`; stable forever, clients key their text on it. */
  id: string;
  /** Topics the prompt fits. "general" fits any call. */
  topics: readonly Topic[];
  en: string;
  hi: string;
}

/** Shorthand for a prompt with one topic. */
const p = (id: string, topics: readonly Topic[], en: string, hi: string): SparkPrompt => ({ id, topics, en, hi });

export const SPARK_PROMPTS: readonly SparkPrompt[] = [
  /* General */
  p("general-01", ["general", "food"], "Best street food in your city?", "आपके शहर का सबसे बढ़िया स्ट्रीट फ़ूड कौन सा है?"),
  p("general-02", ["general"], "Would you rather be able to fly or be invisible?", "आप उड़ना चुनेंगे या अदृश्य होना?"),
  p("general-03", ["general"], "What's the most useless talent you have?", "आपकी सबसे बेकार लेकिन मज़ेदार प्रतिभा कौन सी है?"),
  p("general-04", ["general", "food"], "Tea or coffee, and how do you take it?", "चाय या कॉफ़ी, और कैसे पीते हैं?"),
  p("general-05", ["general"], "What's one thing on your bucket list?", "आपकी बकेट लिस्ट की एक चीज़ क्या है?"),
  p(
    "general-06",
    ["general"],
    "If you could have dinner with anyone alive, who would it be?",
    "अगर आप किसी भी जीवित व्यक्ति के साथ डिनर कर सकें, तो किसके साथ?",
  ),
  p("general-07", ["general"], "What's the best piece of advice you've ever received?", "आपको मिली सबसे अच्छी सलाह कौन सी है?"),
  p("general-08", ["general"], "Morning person or night owl?", "आप सुबह जल्दी उठने वाले हैं या रात के उल्लू?"),
  p(
    "general-09",
    ["general"],
    "What's a small thing that made you smile today?",
    "आज कौन सी छोटी सी बात ने आपको मुस्कुराने पर मजबूर किया?",
  ),
  p(
    "general-10",
    ["general"],
    "If you won a million, what's the first thing you'd buy?",
    "अगर आप दस लाख जीत जाएँ, तो सबसे पहले क्या खरीदेंगे?",
  ),
  p("general-11", ["general", "music"], "What's your go-to karaoke song?", "कराओके में आपका पक्का गाना कौन सा है?"),
  p("general-12", ["general", "travel"], "Mountains or beach for a week off?", "एक हफ़्ते की छुट्टी: पहाड़ या समुद्र तट?"),
  p("general-13", ["general", "food"], "What's the weirdest thing you've eaten?", "आपने अब तक की सबसे अजीब चीज़ क्या खाई है?"),
  p(
    "general-14",
    ["general"],
    "Which superpower would make your daily life easiest?",
    "कौन सी सुपरपावर आपकी रोज़मर्रा की ज़िंदगी सबसे आसान बना देगी?",
  ),
  p("general-15", ["general"], "What's your most-used emoji?", "आपका सबसे ज़्यादा इस्तेमाल होने वाला इमोजी कौन सा है?"),
  p("general-16", ["general"], "Describe your hometown in three words.", "अपने शहर को तीन शब्दों में बताइए।"),
  p(
    "general-17",
    ["general", "music", "movies"],
    "Would you rather live without music or without movies?",
    "आप बिना संगीत के रहेंगे या बिना फ़िल्मों के?",
  ),
  p("general-18", ["general"], "What's a skill you want to learn this year?", "इस साल आप कौन सा हुनर सीखना चाहते हैं?"),
  p("general-19", ["general"], "Cats or dogs, and why?", "बिल्ली या कुत्ता, और क्यों?"),
  p(
    "general-20",
    ["general"],
    "What's the funniest thing that happened to you this week?",
    "इस हफ़्ते आपके साथ सबसे मज़ेदार क्या हुआ?",
  ),
  p(
    "general-21",
    ["general"],
    "What time is it where you are, and what's the weather like?",
    "आपके यहाँ अभी क्या समय है और मौसम कैसा है?",
  ),
  p("general-22", ["general", "food"], "What's your comfort snack at midnight?", "आधी रात का आपका कम्फ़र्ट स्नैक क्या है?"),
  p(
    "general-23",
    ["general"],
    "If you had a free day tomorrow, how would you spend it?",
    "अगर कल पूरा दिन खाली हो, तो आप कैसे बिताएँगे?",
  ),
  p("general-24", ["general"], "What's the last thing you laughed really hard at?", "आखिरी बार आप किस बात पर ज़ोर से हँसे थे?"),
  p(
    "general-25",
    ["general"],
    "Would you rather travel 100 years into the past or the future?",
    "आप 100 साल अतीत में जाना चाहेंगे या भविष्य में?",
  ),

  /* Gaming */
  p(
    "gaming-01",
    ["gaming"],
    "Which game could you play forever without getting bored?",
    "कौन सा गेम आप बिना बोर हुए हमेशा खेल सकते हैं?",
  ),
  p("gaming-02", ["gaming"], "Mobile, console or PC?", "मोबाइल, कंसोल या पीसी?"),
  p("gaming-03", ["gaming"], "What's the first game you remember playing?", "आपको याद है, आपने सबसे पहले कौन सा गेम खेला था?"),
  p("gaming-04", ["gaming", "music"], "Which game has the best soundtrack?", "किस गेम का साउंडट्रैक सबसे बढ़िया है?"),
  p("gaming-05", ["gaming"], "Hardest boss you've ever beaten?", "आपने अब तक का सबसे मुश्किल बॉस कौन सा हराया है?"),
  p("gaming-06", ["gaming"], "Which game world would you move into?", "किस गेम की दुनिया में आप रहने चले जाएँगे?"),
  p("gaming-07", ["gaming"], "Do you play to win or to relax?", "आप जीतने के लिए खेलते हैं या रिलैक्स करने के लिए?"),
  p(
    "gaming-08",
    ["gaming"],
    "What's a game everyone loves but you just don't get?",
    "कौन सा गेम सबको पसंद है पर आपको समझ नहीं आता?",
  ),
  p("gaming-09", ["gaming"], "Best co-op game to play with a friend?", "दोस्त के साथ खेलने के लिए सबसे अच्छा को-ऑप गेम?"),
  p("gaming-10", ["gaming"], "Which retro game deserves a remake?", "किस पुराने गेम का रीमेक बनना चाहिए?"),
  p("gaming-11", ["gaming"], "Open world or story-driven?", "ओपन वर्ल्ड या कहानी वाला गेम?"),
  p("gaming-12", ["gaming"], "What's your longest gaming session ever?", "आपका सबसे लंबा गेमिंग सेशन कितना लंबा था?"),
  p("gaming-13", ["gaming"], "Which game character would you want as a roommate?", "किस गेम कैरेक्टर को आप रूममेट बनाना चाहेंगे?"),
  p(
    "gaming-14",
    ["gaming"],
    "Do you prefer playing games or watching others stream them?",
    "आपको गेम खेलना पसंद है या दूसरों की स्ट्रीम देखना?",
  ),
  p("gaming-15", ["gaming"], "Which game taught you something useful?", "किस गेम ने आपको कुछ काम की चीज़ सिखाई?"),
  p("gaming-16", ["gaming"], "Board games or video games on a rainy day?", "बारिश वाले दिन बोर्ड गेम या वीडियो गेम?"),

  /* Music */
  p("music-01", ["music"], "What song is stuck in your head right now?", "अभी कौन सा गाना आपके दिमाग में अटका हुआ है?"),
  p(
    "music-02",
    ["music"],
    "Which artist would you see live if money were no object?",
    "अगर पैसे की चिंता न हो, तो किस आर्टिस्ट का लाइव शो देखेंगे?",
  ),
  p(
    "music-03",
    ["music"],
    "What's the first album you ever bought or downloaded?",
    "आपने सबसे पहला एल्बम कौन सा खरीदा या डाउनलोड किया था?",
  ),
  p("music-04", ["music"], "Do you play any instrument, or want to?", "क्या आप कोई वाद्य यंत्र बजाते हैं, या बजाना चाहते हैं?"),
  p("music-05", ["music", "travel"], "What music do you put on for a long drive?", "लंबी ड्राइव पर आप कौन सा संगीत चलाते हैं?"),
  p("music-06", ["music"], "Which song always gets you dancing?", "कौन सा गाना आपको हमेशा नचा देता है?"),
  p("music-07", ["music"], "Headphones or speakers?", "हेडफ़ोन या स्पीकर?"),
  p("music-08", ["music"], "What's a guilty-pleasure song you secretly love?", "कौन सा गाना आप चुपके-चुपके पसंद करते हैं?"),
  p("music-09", ["music"], "Which decade had the best music?", "किस दशक का संगीत सबसे अच्छा था?"),
  p("music-10", ["music"], "Name a song that reminds you of school days.", "ऐसा गाना बताइए जो आपको स्कूल के दिन याद दिला दे।"),
  p("music-11", ["music"], "Lyrics or beat: what matters more?", "बोल या बीट: आपके लिए क्या ज़्यादा मायने रखता है?"),
  p("music-12", ["music"], "What's the best concert you've been to?", "आपका देखा हुआ सबसे अच्छा कॉन्सर्ट कौन सा था?"),
  p(
    "music-13",
    ["music"],
    "If your life had a theme song, what would it be?",
    "अगर आपकी ज़िंदगी का थीम सॉन्ग होता, तो कौन सा होता?",
  ),
  p("music-14", ["music"], "Which song would you pick for a sunrise?", "सूर्योदय के लिए आप कौन सा गाना चुनेंगे?"),
  p(
    "music-15",
    ["music"],
    "Hum your favourite tune and see if it gets guessed!",
    "अपनी पसंदीदा धुन गुनगुनाइए, देखते हैं पहचान में आती है या नहीं!",
  ),
  p("music-16", ["music"], "Which song do you know every single word of?", "किस गाने का हर एक शब्द आपको याद है?"),

  /* Movies */
  p("movies-01", ["movies"], "What movie can you watch over and over?", "कौन सी फ़िल्म आप बार-बार देख सकते हैं?"),
  p("movies-02", ["movies"], "Last movie that made you cry?", "आखिरी फ़िल्म जिसने आपको रुला दिया?"),
  p(
    "movies-03",
    ["movies"],
    "Which actor would play you in a movie about your life?",
    "आपकी ज़िंदगी पर बनी फ़िल्म में आपका किरदार कौन सा एक्टर निभाएगा?",
  ),
  p("movies-04", ["movies"], "Best movie villain of all time?", "अब तक का सबसे बढ़िया फ़िल्मी विलेन कौन है?"),
  p("movies-05", ["movies"], "Cinema or couch?", "सिनेमा हॉल या घर का सोफ़ा?"),
  p(
    "movies-06",
    ["movies"],
    "What's a movie you loved as a kid that aged badly?",
    "बचपन में कौन सी फ़िल्म पसंद थी जो अब देखो तो हँसी आती है?",
  ),
  p("movies-07", ["movies"], "Which series did you binge in one weekend?", "कौन सी सीरीज़ आपने एक वीकेंड में पूरी देख डाली?"),
  p("movies-08", ["movies"], "Pick a movie I should watch tonight.", "कोई फ़िल्म बताइए जो मुझे आज रात देखनी चाहिए।"),
  p("movies-09", ["movies", "music"], "Which movie has the best soundtrack?", "किस फ़िल्म का संगीत सबसे अच्छा है?"),
  p("movies-10", ["movies"], "Comedy, thriller or drama for a Friday night?", "शुक्रवार की रात: कॉमेडी, थ्रिलर या ड्रामा?"),
  p("movies-11", ["movies"], "Which movie quote do you use in real life?", "कौन सा फ़िल्मी डायलॉग आप असल ज़िंदगी में बोलते हैं?"),
  p("movies-12", ["movies"], "What's the most overrated movie ever?", "सबसे ज़्यादा ओवररेटेड फ़िल्म कौन सी है?"),
  p("movies-13", ["movies"], "If you could live inside one movie, which one?", "अगर आप किसी एक फ़िल्म के अंदर रह सकें, तो कौन सी?"),
  p("movies-14", ["movies"], "Subtitles on or off?", "सबटाइटल ऑन या ऑफ़?"),
  p("movies-15", ["movies"], "Which movie ending would you change?", "किस फ़िल्म का अंत आप बदल देंगे?"),
  p("movies-16", ["movies", "food"], "Popcorn: sweet, salty or caramel?", "पॉपकॉर्न: मीठा, नमकीन या कैरेमल?"),

  /* Sports */
  p("sports-01", ["sports"], "Which sport did you play as a kid?", "बचपन में आप कौन सा खेल खेलते थे?"),
  p("sports-02", ["sports"], "Best match you've ever watched?", "आपका देखा हुआ सबसे शानदार मैच कौन सा है?"),
  p("sports-03", ["sports"], "Which athlete inspires you the most?", "कौन सा खिलाड़ी आपको सबसे ज़्यादा प्रेरित करता है?"),
  p("sports-04", ["sports"], "Playing or watching: which do you enjoy more?", "खेलना या देखना: आपको क्या ज़्यादा मज़ा देता है?"),
  p("sports-05", ["sports"], "Cricket, football or something else?", "क्रिकेट, फ़ुटबॉल या कुछ और?"),
  p("sports-06", ["sports"], "What's a sport you'd love to try once?", "कौन सा खेल आप एक बार ज़रूर आज़माना चाहेंगे?"),
  p("sports-07", ["sports"], "Early morning run or evening gym?", "सुबह की दौड़ या शाम का जिम?"),
  p("sports-08", ["sports"], "Which team do you support, and since when?", "आप किस टीम को सपोर्ट करते हैं, और कब से?"),
  p("sports-09", ["sports"], "What's your proudest sporting moment?", "खेल में आपका सबसे गर्व वाला पल कौन सा है?"),
  p("sports-10", ["sports"], "Which sport is the most fun to watch live?", "कौन सा खेल स्टेडियम में देखने में सबसे मज़ेदार है?"),
  p(
    "sports-11",
    ["sports"],
    "Would you rather win an Olympic medal or a World Cup?",
    "आप ओलंपिक मेडल जीतना चाहेंगे या वर्ल्ड कप?",
  ),
  p(
    "sports-12",
    ["sports"],
    "Do you have a lucky jersey or ritual for big games?",
    "बड़े मैचों के लिए आपकी कोई लकी जर्सी या रस्म है?",
  ),
  p("sports-13", ["sports"], "Is chess a sport? Defend your answer!", "क्या शतरंज एक खेल है? अपना जवाब साबित कीजिए!"),
  p("sports-14", ["sports"], "Which sport would you add to the Olympics?", "आप ओलंपिक में कौन सा खेल जोड़ेंगे?"),
  p("sports-15", ["sports"], "What's the most unusual sport you've watched?", "आपने अब तक का सबसे अनोखा खेल कौन सा देखा है?"),
  p("sports-16", ["sports"], "Team sports or solo sports?", "टीम वाले खेल या अकेले खेले जाने वाले?"),

  /* Technology */
  p(
    "technology-01",
    ["technology"],
    "What's the one app you can't live without?",
    "वो एक ऐप कौन सा है जिसके बिना आप नहीं रह सकते?",
  ),
  p("technology-02", ["technology"], "Android or iPhone, and why?", "एंड्रॉइड या आईफ़ोन, और क्यों?"),
  p(
    "technology-03",
    ["technology", "movies"],
    "What gadget from sci-fi do you wish existed?",
    "साइंस-फ़िक्शन का कौन सा गैजेट आप चाहते हैं कि असल में होता?",
  ),
  p("technology-04", ["technology"], "What was your first phone?", "आपका पहला फ़ोन कौन सा था?"),
  p("technology-05", ["technology"], "Dark mode or light mode?", "डार्क मोड या लाइट मोड?"),
  p("technology-06", ["technology"], "What tech would you uninvent?", "कौन सी तकनीक आप चाहते हैं कि कभी बनी ही न होती?"),
  p("technology-07", ["technology"], "Would you take a one-way trip to Mars?", "क्या आप मंगल ग्रह की एकतरफ़ा यात्रा पर जाएँगे?"),
  p(
    "technology-08",
    ["technology"],
    "How many unread notifications do you have right now?",
    "अभी आपके पास कितने अनपढ़े नोटिफ़िकेशन हैं?",
  ),
  p("technology-09", ["technology"], "What's a tech skill you learned on your own?", "कौन सा टेक स्किल आपने खुद से सीखा?"),
  p(
    "technology-10",
    ["technology"],
    "Would you rather have no internet for a week or no phone?",
    "आप एक हफ़्ते बिना इंटरनेट रहना चाहेंगे या बिना फ़ोन?",
  ),
  p(
    "technology-11",
    ["technology"],
    "What's the oldest gadget you still use?",
    "सबसे पुराना गैजेट कौन सा है जो आप आज भी इस्तेमाल करते हैं?",
  ),
  p("technology-12", ["technology"], "Robots doing your chores: yes or no?", "घर के काम रोबोट करें: हाँ या ना?"),
  p("technology-13", ["technology"], "What's your screen time looking like this week?", "इस हफ़्ते आपका स्क्रीन टाइम कैसा चल रहा है?"),
  p("technology-14", ["technology"], "If you could build any app, what would it do?", "अगर आप कोई भी ऐप बना सकें, तो वो क्या करेगा?"),
  p("technology-15", ["technology", "music"], "Wired or wireless headphones?", "वायर वाले हेडफ़ोन या वायरलेस?"),
  p(
    "technology-16",
    ["technology"],
    "What's the best thing you've found on the internet this month?",
    "इस महीने इंटरनेट पर आपको सबसे अच्छी चीज़ क्या मिली?",
  ),

  /* Art */
  p("art-01", ["art"], "Do you draw, paint or make anything?", "क्या आप ड्रॉइंग, पेंटिंग या कुछ बनाते हैं?"),
  p("art-02", ["art"], "What's the most beautiful thing you've seen this week?", "इस हफ़्ते आपने सबसे सुंदर चीज़ क्या देखी?"),
  p("art-03", ["art"], "Which colour describes your mood today?", "आज आपके मूड को कौन सा रंग बयान करता है?"),
  p("art-04", ["art"], "Street art or museum art?", "स्ट्रीट आर्ट या म्यूज़ियम की कला?"),
  p("art-05", ["art"], "If you could own one famous painting, which one?", "अगर आप कोई एक मशहूर पेंटिंग रख सकें, तो कौन सी?"),
  p("art-06", ["art"], "What's a craft you'd love to learn?", "कौन सी हस्तकला आप सीखना चाहेंगे?"),
  p("art-07", ["art"], "Draw something in the air and see if it gets guessed!", "हवा में कुछ बनाइए, देखें पहचान में आता है या नहीं!"),
  p("art-08", ["art"], "What's your favourite photo you've taken?", "आपकी खींची हुई सबसे पसंदीदा फ़ोटो कौन सी है?"),
  p("art-09", ["art"], "Do you doodle during calls or meetings?", "क्या आप कॉल या मीटिंग के दौरान डूडल बनाते हैं?"),
  p("art-10", ["art", "travel"], "Which building in your city is the prettiest?", "आपके शहर की सबसे सुंदर इमारत कौन सी है?"),
  p("art-11", ["art"], "Pencil, paint or pixels?", "पेंसिल, पेंट या पिक्सल?"),
  p("art-12", ["art"], "What's a piece of art that stuck with you?", "कौन सी कलाकृति आपके ज़हन में बस गई?"),
  p("art-13", ["art"], "If you designed a tattoo, what would it be?", "अगर आप एक टैटू डिज़ाइन करें, तो क्या बनाएँगे?"),
  p(
    "art-14",
    ["art", "technology"],
    "What's your favourite font? Yes, people have those.",
    "आपका पसंदीदा फ़ॉन्ट कौन सा है? हाँ, ऐसा भी होता है।",
  ),
  p("art-15", ["art"], "Which season would you paint first?", "कौन सा मौसम आप सबसे पहले पेंट करेंगे?"),
  p("art-16", ["art"], "Show me something handmade near you.", "अपने पास की कोई हाथ से बनी चीज़ दिखाइए।"),

  /* Travel */
  p(
    "travel-01",
    ["travel"],
    "Where was your last trip, and what was the best part?",
    "आपकी पिछली यात्रा कहाँ थी, और सबसे अच्छी बात क्या थी?",
  ),
  p("travel-02", ["travel"], "Window seat or aisle seat?", "खिड़की वाली सीट या गलियारे वाली?"),
  p("travel-03", ["travel"], "Which city would you move to tomorrow?", "कौन से शहर में आप कल ही शिफ़्ट हो जाएँगे?"),
  p("travel-04", ["travel"], "Train, bus or plane for a long journey?", "लंबे सफ़र के लिए ट्रेन, बस या हवाई जहाज़?"),
  p("travel-05", ["travel"], "What's the best thing about where you live?", "आप जहाँ रहते हैं, वहाँ की सबसे अच्छी बात क्या है?"),
  p(
    "travel-06",
    ["travel"],
    "What's one place everyone should visit once?",
    "ऐसी एक जगह जहाँ हर किसी को एक बार ज़रूर जाना चाहिए?",
  ),
  p("travel-07", ["travel"], "Do you pack light or bring everything?", "आप हल्का सामान ले जाते हैं या सब कुछ ठूँस लेते हैं?"),
  p("travel-08", ["travel"], "Solo trip or group trip?", "अकेले की यात्रा या दोस्तों के साथ?"),
  p("travel-09", ["travel"], "What's the funniest thing that happened on a trip?", "किसी यात्रा में आपके साथ सबसे मज़ेदार क्या हुआ?"),
  p(
    "travel-10",
    ["travel", "food"],
    "Which local dish should a visitor to your city try first?",
    "आपके शहर आने वाले को सबसे पहले कौन सी लोकल डिश चखनी चाहिए?",
  ),
  p("travel-11", ["travel", "music"], "Road trip: who picks the music?", "रोड ट्रिप पर गाने कौन चुनता है?"),
  p("travel-12", ["travel"], "What's a place that looked better in photos?", "कौन सी जगह फ़ोटो में असलियत से बेहतर लगती थी?"),
  p("travel-13", ["travel"], "Teach me one word from your language.", "अपनी भाषा का एक शब्द मुझे सिखाइए।"),
  p("travel-14", ["travel"], "What's the longest journey you've ever taken?", "आपका अब तक का सबसे लंबा सफ़र कौन सा था?"),
  p("travel-15", ["travel"], "Camping under the stars or a fancy hotel?", "तारों के नीचे कैंपिंग या शानदार होटल?"),
  p("travel-16", ["travel", "food"], "Which country's food would you travel for?", "किस देश के खाने के लिए आप यात्रा करेंगे?"),

  /* Food */
  p("food-01", ["food"], "Spicy, sweet or salty?", "तीखा, मीठा या नमकीन?"),
  p("food-02", ["food"], "What's the one dish you cook really well?", "वो एक डिश कौन सी है जो आप बहुत अच्छी बनाते हैं?"),
  p("food-03", ["food"], "What did you eat today?", "आज आपने क्या खाया?"),
  p("food-04", ["food"], "Pineapple on pizza: yes or no?", "पिज़्ज़ा पर पाइनएप्पल: हाँ या ना?"),
  p("food-05", ["food"], "What's your ultimate comfort food?", "आपका सबसे बड़ा कम्फ़र्ट फ़ूड क्या है?"),
  p("food-06", ["food"], "Home-cooked or restaurant?", "घर का खाना या रेस्तरां का?"),
  p(
    "food-07",
    ["food"],
    "What's a food you hated as a kid but love now?",
    "कौन सा खाना बचपन में नापसंद था पर अब पसंद है?",
  ),
  p("food-08", ["food"], "Describe your dream breakfast.", "अपने सपनों का नाश्ता बताइए।"),
  p("food-09", ["food"], "What's the best dessert in your country?", "आपके देश की सबसे बढ़िया मिठाई कौन सी है?"),
  p("food-10", ["food"], "Which food could you eat every day forever?", "कौन सा खाना आप रोज़ हमेशा के लिए खा सकते हैं?"),
  p("food-11", ["food"], "Chai with biscuits or coffee with cake?", "चाय के साथ बिस्कुट या कॉफ़ी के साथ केक?"),
  p(
    "food-12",
    ["food"],
    "What's the most expensive meal you've had, and was it worth it?",
    "आपका सबसे महँगा खाना कौन सा था, और क्या वो इसके लायक था?",
  ),
  p("food-13", ["food"], "Which fruit is the king of fruits? Defend it!", "फलों का राजा कौन सा है? साबित कीजिए!"),
  p("food-14", ["food"], "Do you eat to live or live to eat?", "आप जीने के लिए खाते हैं या खाने के लिए जीते हैं?"),
  p("food-15", ["food"], "What's a snack from your country I should try?", "आपके देश का कोई स्नैक जो मुझे आज़माना चाहिए?"),
  p("food-16", ["food"], "Sweet breakfast or savoury breakfast?", "मीठा नाश्ता या नमकीन नाश्ता?"),

  /* Books */
  p("books-01", ["books"], "What book are you reading right now?", "आप अभी कौन सी किताब पढ़ रहे हैं?"),
  p("books-02", ["books"], "Which book changed how you think?", "किस किताब ने आपकी सोच बदल दी?"),
  p("books-03", ["books"], "Paper, e-book or audiobook?", "कागज़ की किताब, ई-बुक या ऑडियोबुक?"),
  p(
    "books-04",
    ["books"],
    "Which fictional character would you be friends with?",
    "किस काल्पनिक किरदार से आप दोस्ती करना चाहेंगे?",
  ),
  p(
    "books-05",
    ["books"],
    "What's a book everyone should read before 30?",
    "ऐसी कौन सी किताब है जो हर किसी को 30 से पहले पढ़नी चाहिए?",
  ),
  p("books-06", ["books"], "Did you ever finish a book in one sitting?", "क्या आपने कभी एक बैठक में पूरी किताब खत्म की है?"),
  p("books-07", ["books", "movies"], "Which book was better than its movie?", "कौन सी किताब अपनी फ़िल्म से बेहतर थी?"),
  p("books-08", ["books"], "What's your favourite opening line of a book?", "किसी किताब की आपकी पसंदीदा पहली पंक्ति कौन सी है?"),
  p("books-09", ["books"], "If you wrote a book, what would the title be?", "अगर आप किताब लिखें, तो उसका नाम क्या होगा?"),
  p("books-10", ["books"], "Comics count as books. Agree or disagree?", "कॉमिक्स भी किताबें हैं। सहमत या असहमत?"),
  p("books-11", ["books"], "Which author would you like to meet?", "किस लेखक से आप मिलना चाहेंगे?"),
  p("books-12", ["books"], "What's the last book that made you laugh?", "आखिरी किताब जिसने आपको हँसाया?"),
  p("books-13", ["books"], "Do you read the ending first? Be honest.", "क्या आप पहले अंत पढ़ लेते हैं? सच बताइए।"),
  p("books-14", ["books"], "Which book would you give a stranger?", "कौन सी किताब आप किसी अजनबी को देना चाहेंगे?"),
  p("books-15", ["books"], "Poetry or prose?", "कविता या गद्य?"),
  p("books-16", ["books"], "What's a childhood story you still remember?", "बचपन की कौन सी कहानी आपको आज भी याद है?"),
];
