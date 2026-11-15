/**
 * @fileoverview 反重力（Antigravity）模型真身检测纯数学核心（ModelDial 数字指纹协议，零外部依赖）。
 *
 * 核心能力：
 * 1. AES-256-CTR 确定性熵源与 8 语种无语义整数选择探针生成（292..332 个 1..355 整数）；
 * 2. `data/detector.bin` 字节转置 Float32 解码器与内置 `seed-bank.zip` 纯 Node 读取器；
 * 3. 主引擎 `shared-detector-v2`（Hellinger 边际频率 + 四分段块特征 + Legendre 位置核 + 斐波那契滞后自相关 + 马尔可夫转移 + 闭集温度校准）与辅助引擎 `ModelTrace`；
 * 4. 专为 Antigravity 模型目录设计的参考对齐器（自动剥离 `-xhigh/-high/-medium/-low` 思考档位后缀并映射 `Orchestrator (Carbon/Argon)` 包装模型）。
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const MD_VALUE_MIN = 1;
export const MD_VALUE_MAX = 355;
export const MD_DIMENSION = MD_VALUE_MAX - MD_VALUE_MIN + 1;

const MD_ALPHA = 0.5;
const MD_POSITIONAL_WEIGHTS = Object.freeze([0.6, 0.15, 0.125, 0.125]);
const MD_CENTRES = Object.freeze(Array.from({ length: 24 }, (_, i) => 1 + (i * 354) / 23));
const MD_LAGS = Object.freeze([1, 2, 3, 5, 8, 13, 21, 34]);
const MD_SEQUENCE_LIMITS = Object.freeze({ autocorrelation: -0.23, small_step_share: 0.05 });
const MD_MERGED_GROUP_ID = 'gpt-6-astra';

export const GEMINI4_PAIR = Object.freeze(['gemini-4-carbon', 'gemini-4-argon']);
export const FIVE_LANGUAGE_SCHEMA = 'modeldial-lm-challenge-set-v1';
export const CHALLENGE_SCHEMA = 'modeldial-lm-challenge-set-v2';

export const FIVE_LANGUAGE_IDENTITY = Object.freeze({
  protocol: 'lm-detector-random-multilingual-v1',
  rulesVersion: 'multilingual-20261101',
  rulesHash: '297fd2bd8a8342d6dfd11b8641555583da32f70b64002972be24959011d2093b',
});

export const RANDOM_IDENTITY = Object.freeze({
  protocol: 'lm-detector-random-multilingual-v1',
  rulesVersion: 'multilingual-eight-20261101',
  rulesHash: '2217ce244e589b89f602037025c478f5135989cbb5bea570489f1235782fb43a',
});

export const REQUIRED_BANK_ASSETS = Object.freeze([
  'data/detector.bin',
  'data/primary.json',
  'data/modeltrace.json',
  'rules.json',
]);

// ---------------------------------------------------------------------------
// 1. 8 语种无语义整数探针模板（与 ModelDial v2 协议逐字对齐）
// ---------------------------------------------------------------------------

const MD_BASE_LANGUAGES = {
  zh: {
    code: 'zh',
    label: '中文',
    space: '',
    openings: [
      '这是一次独立的数值选择记录。',
      '请完成下面的无语义整数选择任务。',
      '执行一次第一反应取值记录。',
      '生成一组不承载语义的整数选择。',
      '进行一轮快速逐项取值。',
    ],
    actions: [
      '为各个位置分别凭第一反应选择',
      '逐项选择',
      '每次只决定当前一项，共给出',
      '分别凭第一反应给出',
      '逐个直接选择',
    ],
    request: (action, count) => `${action} ${count} 个 1 到 355（含端点）的整数。`,
    rules:
      '每个位置都要单独选择；不要从 1 开始计数，不要连续递增或递减，也不要采用等差、循环、重复区块或其他规则化模式。' +
      '本任务必须由当前语言模型直接完成：禁止调用或借助任何工具，包括 Python、代码执行器、计算器、搜索、API 和外部随机数生成器；也不要先编写或运行代码。',
    endings: [
      '允许某个数字再次出现；每项写出后不要回头排序、去重或替换。',
      '偶然重复是有效的；不要重新排列或修正已经写出的项目。',
      '相同值可以再次出现；输出过程中不要整理或改写前面的项目。',
      '重复值无需删除；不要筛选、重排或补成某种规律。',
      '不必赋予数字任何含义；已经给出的值保持不变。',
    ],
    separators: [
      '数字之间用逗号或空格分隔均可。',
      '使用一种一致的常见分隔符即可。',
      '可以用逗号、空格或换行分隔。',
      '只要每个整数边界清楚，格式可自行选择。',
    ],
    start: '直接从第一个取值开始输出，不要在序列前重复数量、范围或任务说明。',
  },
  en: {
    code: 'en',
    label: 'English',
    space: ' ',
    openings: [
      'This is an independent record of numerical choices.',
      'Complete the following integer-choice task, which carries no semantic meaning.',
      'Record a round of first-instinct choices.',
      'Generate a set of integer choices that carry no meaning.',
      'Make a quick round of item-by-item choices.',
    ],
    actions: [
      'For each position, choose separately by first instinct',
      'Choose, item by item,',
      'Decide only the current item each time, giving a total of',
      'Give, each by first instinct,',
      'Choose directly, one by one,',
    ],
    request: (action, count) => `${action} ${count} integers from 1 to 355, inclusive.`,
    rules:
      'Choose separately for every position; do not count up from 1, do not increase or decrease consecutively, and do not use arithmetic progressions, cycles, repeated blocks, or other systematic patterns. ' +
      'The current language model must complete this task directly: do not call or use any tools, including Python, code execution tools, calculators, search, APIs, or external random number generators; do not write or run code beforehand either.',
    endings: [
      'A number may appear again; after writing each item, do not go back to sort, deduplicate, or replace it.',
      'Accidental repetitions are valid; do not rearrange or correct items already written.',
      'The same value may appear again; do not organize or rewrite earlier items while producing the output.',
      'Repeated values do not need to be removed; do not filter, reorder, or fill the sequence into a pattern.',
      'Do not assign meaning to the numbers; keep values already given unchanged.',
    ],
    separators: [
      'Separate the numbers with commas or spaces.',
      'Use one consistent common separator.',
      'You may separate the numbers with commas, spaces, or line breaks.',
      'Choose any format that clearly separates each integer.',
    ],
    start:
      'Start the output directly with the first chosen value; do not repeat the count, range, or task instructions before the sequence.',
  },
  ja: {
    code: 'ja',
    label: '日本語',
    space: '',
    openings: [
      'これは独立した数値選択の記録です。',
      '意味を持たない次の整数選択課題を完了してください。',
      '直感で選んだ値を記録してください。',
      '意味を持たない整数の選択を一組生成してください。',
      '一項目ずつ素早く値を選んでください。',
    ],
    actions: [
      '各位置について個別に直感で、',
      '一項目ずつ、',
      '毎回その時点の一項目だけを決めて、',
      'それぞれ直感で、',
      '一つずつ直接、',
    ],
    request: (action, count) => `${action}1 から 355 まで（両端を含む）の整数を ${count} 個選んでください。`,
    rules:
      '各位置の値は個別に選んでください。1 から順に数えたり、連続して増加または減少させたりせず、等差数列、周期、同じブロックの繰り返し、その他の規則的なパターンも使わないでください。' +
      'この課題は現在の言語モデル自身が直接行ってください。Python、コード実行ツール、計算機、検索、API、外部の乱数生成器など、いかなるツールも呼び出したり利用したりしないでください。事前にコードを書いたり実行したりすることも禁止します。',
    endings: [
      '同じ数字が再び現れてもかまいません。各項目を書いた後に戻って、並べ替え、重複の削除、置き換えをしないでください。',
      '偶然の重複は有効です。すでに書いた項目を並べ替えたり修正したりしないでください。',
      '同じ値が再び出てもかまいません。出力の途中で前の項目を整理したり書き換えたりしないでください。',
      '重複した値を削除する必要はありません。選別、並べ替え、規則的なパターンへの補完をしないでください。',
      '数字に意味を持たせる必要はありません。すでに出した値は変えないでください。',
    ],
    separators: [
      '数字はコンマまたは空白で区切ってください。',
      '一般的な区切り文字を一種類、統一して使ってください。',
      'コンマ、空白、改行のいずれかで数字を区切ってください。',
      '各整数の区切りが明確であれば、形式は自由です。',
    ],
    start: '選んだ最初の値から直接出力を始め、数列の前に個数、範囲、課題の説明を繰り返さないでください。',
  },
  ko: {
    code: 'ko',
    label: '한국어',
    space: ' ',
    openings: [
      '이것은 독립적인 수치 선택 기록입니다.',
      '다음의 의미 없는 정수 선택 과제를 완료하세요.',
      '첫 직감에 따른 값 선택을 한 번 기록하세요.',
      '의미를 담지 않은 정수 선택을 한 세트 생성하세요.',
      '항목별로 빠르게 값을 고르는 라운드를 진행하세요.',
    ],
    actions: ['각 위치마다 첫 직감으로 따로', '항목별로', '매번 현재 항목 하나만 정하면서', '각각 첫 직감으로', '하나씩 바로'],
    request: (action, count) => `${action} 1부터 355까지(양 끝 포함)의 정수 ${count}개를 고르세요.`,
    rules:
      '각 위치의 값은 따로 고르세요. 1부터 차례로 세지 말고, 연속으로 증가하거나 감소하지 말며, 등차수열, 순환, 반복되는 블록 또는 그 밖의 규칙적인 패턴도 사용하지 마세요. ' +
      '이 과제는 현재 언어 모델이 직접 수행해야 합니다. Python, 코드 실행기, 계산기, 검색, API, 외부 난수 생성기를 포함한 어떤 도구도 호출하거나 이용하지 마세요. 미리 코드를 작성하거나 실행하지도 마세요.',
    endings: [
      '같은 숫자가 다시 나와도 됩니다. 각 항목을 쓴 뒤 되돌아가서 정렬하거나 중복을 제거하거나 바꾸지 마세요.',
      '우연한 중복도 유효합니다. 이미 쓴 항목을 다시 배열하거나 고치지 마세요.',
      '같은 값이 다시 나와도 됩니다. 출력하는 동안 앞의 항목을 정리하거나 고쳐 쓰지 마세요.',
      '중복된 값을 지울 필요는 없습니다. 걸러 내거나 다시 배열하거나 어떤 규칙에 맞춰 채우지 마세요.',
      '숫자에 어떤 의미도 부여할 필요가 없습니다. 이미 제시한 값은 그대로 두세요.',
    ],
    separators: [
      '숫자는 쉼표나 공백으로 구분하면 됩니다.',
      '일반적인 구분 기호 하나를 일관되게 사용하세요.',
      '쉼표, 공백 또는 줄바꿈으로 구분할 수 있습니다.',
      '각 정수의 경계만 분명하면 형식은 자유롭게 정해도 됩니다.',
    ],
    start: '고른 첫 번째 값부터 바로 출력하고, 수열 앞에 개수, 범위 또는 과제 설명을 반복하지 마세요.',
  },
  fr: {
    code: 'fr',
    label: 'Français',
    space: ' ',
    openings: [
      'Ceci est un relevé indépendant de choix numériques.',
      'Veuillez accomplir la tâche suivante de choix d’entiers sans signification sémantique.',
      'Consignez une série de choix faits au premier réflexe.',
      'Générez une série de choix d’entiers dépourvus de sens.',
      'Effectuez une série rapide de choix, élément par élément.',
    ],
    actions: [
      'Pour chaque position, choisissez séparément au premier réflexe',
      'Choisissez, élément par élément,',
      'À chaque étape, décidez uniquement de la valeur actuelle, pour donner au total',
      'Donnez séparément au premier réflexe',
      'Choisissez directement, un par un,',
    ],
    request: (action, count) => `${action} ${count} entiers compris entre 1 et 355, bornes incluses.`,
    rules:
      'Choisissez séparément pour chaque position ; ne comptez pas à partir de 1, ne produisez pas de valeurs consécutives croissantes ou décroissantes, et ne suivez pas de progression arithmétique, de cycle, de blocs répétés ou d’autre motif systématique. ' +
      'Le modèle de langage actuel doit accomplir cette tâche directement : n’appelez et n’utilisez aucun outil, notamment Python, un exécuteur de code, une calculatrice, une recherche, une API ou un générateur externe de nombres aléatoires ; n’écrivez et n’exécutez pas de code au préalable.',
    endings: [
      'Un nombre peut réapparaître ; après avoir écrit chaque élément, ne revenez pas en arrière pour le trier, supprimer les doublons ou le remplacer.',
      'Les répétitions accidentelles sont valides ; ne réorganisez et ne corrigez pas les éléments déjà écrits.',
      'Une même valeur peut réapparaître ; pendant la sortie, ne réorganisez et ne réécrivez pas les éléments précédents.',
      'Les valeurs répétées n’ont pas besoin d’être supprimées ; ne filtrez pas, ne réordonnez pas et ne complétez pas la séquence pour former un motif.',
      'N’attribuez aucune signification aux nombres ; gardez inchangées les valeurs déjà données.',
    ],
    separators: [
      'Séparez les nombres par des virgules ou des espaces.',
      'Utilisez un séparateur courant et cohérent.',
      'Vous pouvez séparer les nombres par des virgules, des espaces ou des retours à la ligne.',
      'Choisissez librement le format, pourvu que la limite de chaque entier soit claire.',
    ],
    start:
      'Commencez directement par la première valeur choisie, sans répéter le nombre d’éléments, l’intervalle ou les consignes avant la séquence.',
  },
};

const MD_EXTRA_LANGUAGES = {
  es: {
    code: 'es',
    label: 'Español',
    space: ' ',
    openings: [
      'Este es un registro independiente de elecciones numéricas.',
      'Completa la siguiente tarea de elección de enteros sin significado semántico.',
      'Registra una ronda de elecciones por primera intuición.',
      'Genera un conjunto de elecciones de enteros que no transmitan significado.',
      'Haz una ronda rápida de elecciones, elemento por elemento.',
    ],
    actions: [
      'Para cada posición, elige por separado según tu primera intuición',
      'Elige, elemento por elemento,',
      'Decide solo el elemento actual cada vez y proporciona un total de',
      'Proporciona, cada uno por primera intuición,',
      'Elige directamente, uno por uno,',
    ],
    request: (action, count) => `${action} ${count} números enteros entre 1 y 355, ambos incluidos.`,
    rules:
      'Elige cada posición por separado; no cuentes desde 1, no sigas una secuencia creciente o decreciente y no uses progresiones aritméticas, ciclos, bloques repetidos ni otros patrones sistemáticos. ' +
      'El modelo de lenguaje actual debe completar esta tarea directamente: no llames ni uses herramientas, incluidos Python, ejecutores de código, calculadoras, búsquedas, API o generadores externos de números aleatorios; tampoco escribas ni ejecutes código previamente.',
    endings: [
      'Un número puede aparecer de nuevo; después de escribir cada elemento, no vuelvas atrás para ordenar, eliminar duplicados o reemplazarlo.',
      'Las repeticiones ocasionales son válidas; no reordenes ni corrijas los elementos ya escritos.',
      'El mismo valor puede aparecer de nuevo; no organices ni reescribas los elementos anteriores mientras produces la respuesta.',
      'No es necesario eliminar valores repetidos; no filtres, reordenes ni completes la secuencia para formar un patrón.',
      'No asignes significado a los números; conserva sin cambios los valores ya dados.',
    ],
    separators: [
      'Separa los números con comas o espacios.',
      'Usa un separador habitual de forma coherente.',
      'Puedes separar los números con comas, espacios o saltos de línea.',
      'Elige cualquier formato que delimite claramente cada entero.',
    ],
    start:
      'Empieza directamente por el primer valor elegido, sin repetir la cantidad, el intervalo ni las instrucciones antes de la secuencia.',
  },
  de: {
    code: 'de',
    label: 'Deutsch',
    space: ' ',
    openings: [
      'Dies ist eine unabhängige Aufzeichnung numerischer Entscheidungen.',
      'Erledige die folgende Auswahlaufgabe für ganze Zahlen ohne semantische Bedeutung.',
      'Halte eine Runde von Entscheidungen nach dem ersten Impuls fest.',
      'Erzeuge eine Folge ausgewählter ganzer Zahlen ohne inhaltliche Bedeutung.',
      'Triff zügig eine Auswahl nach der anderen.',
    ],
    actions: [
      'Wähle für jede Position unabhängig nach dem ersten Impuls',
      'Wähle einzeln',
      'Entscheide jedes Mal nur über die aktuelle Position und liefere insgesamt',
      'Gib jeweils nach dem ersten Impuls',
      'Wähle direkt, eine Zahl nach der anderen,',
    ],
    request: (action, count) => `${action} ${count} ganze Zahlen von 1 bis 355 einschließlich beider Grenzen.`,
    rules:
      'Wähle jede Position einzeln; zähle nicht von 1 an, erzeuge keine fortlaufend steigende oder fallende Folge und verwende keine arithmetischen Folgen, Zyklen, wiederholten Blöcke oder anderen systematischen Muster. ' +
      'Das aktuelle Sprachmodell muss diese Aufgabe unmittelbar selbst erledigen: Rufe keine Werkzeuge auf und nutze keine Werkzeuge, einschließlich Python, Codeausführung, Taschenrechner, Suche, APIs und externer Zufallszahlengeneratoren; schreibe oder führe auch vorher keinen Code aus.',
    endings: [
      'Eine Zahl darf erneut vorkommen; sortiere, bereinige oder ersetze bereits geschriebene Elemente nicht nachträglich.',
      'Zufällige Wiederholungen sind gültig; ordne bereits geschriebene Elemente nicht um und korrigiere sie nicht.',
      'Derselbe Wert darf erneut vorkommen; ordne oder überarbeite frühere Elemente während der Ausgabe nicht.',
      'Wiederholte Werte müssen nicht entfernt werden; filtere oder sortiere die Folge nicht und ergänze sie nicht zu einem Muster.',
      'Weise den Zahlen keine Bedeutung zu; lasse bereits ausgegebene Werte unverändert.',
    ],
    separators: [
      'Trenne die Zahlen durch Kommas oder Leerzeichen.',
      'Verwende ein übliches Trennzeichen einheitlich.',
      'Du darfst die Zahlen durch Kommas, Leerzeichen oder Zeilenumbrüche trennen.',
      'Wähle ein Format, in dem jede ganze Zahl klar abgegrenzt ist.',
    ],
    start:
      'Beginne direkt mit dem ersten gewählten Wert, ohne Anzahl, Wertebereich oder Aufgabenbeschreibung vor der Folge zu wiederholen.',
  },
  ru: {
    code: 'ru',
    label: 'Русский',
    space: ' ',
    openings: [
      'Это независимая запись числовых выборов.',
      'Выполни следующую задачу выбора целых чисел без смыслового содержания.',
      'Запиши серию выборов по первому побуждению.',
      'Создай набор выбранных целых чисел, не несущих смысла.',
      'Быстро выбирай значения по одному.',
    ],
    actions: [
      'Для каждой позиции отдельно выбери по первому побуждению',
      'Выбери по одному',
      'Каждый раз решай только за текущую позицию и выдай всего',
      'Выдай, выбирая каждое по первому побуждению,',
      'Выбери напрямую, одно за другим,',
    ],
    request: (action, count) => `${action} ${count} целых чисел от 1 до 355 включительно.`,
    rules:
      'Выбирай каждую позицию отдельно; не считай от 1, не создавай последовательно возрастающий или убывающий ряд и не используй арифметические прогрессии, циклы, повторяющиеся блоки или другие закономерные шаблоны. ' +
      'Текущая языковая модель должна выполнить задачу самостоятельно и напрямую: не вызывай и не используй никакие инструменты, включая Python, выполнение кода, калькуляторы, поиск, API и внешние генераторы случайных чисел; также не пиши и не запускай код заранее.',
    endings: [
      'Число может появиться снова; записав элемент, не возвращайся назад, чтобы сортировать, удалять повторы или заменять его.',
      'Случайные повторы допустимы; не переставляй и не исправляй уже записанные элементы.',
      'Одно и то же значение может появиться снова; не упорядочивай и не переписывай предыдущие элементы во время вывода.',
      'Повторяющиеся значения удалять не нужно; не фильтруй и не переставляй числа и не достраивай ряд до закономерности.',
      'Не придавай числам смысл; оставляй уже выданные значения без изменений.',
    ],
    separators: [
      'Разделяй числа запятыми или пробелами.',
      'Используй один обычный разделитель последовательно.',
      'Можно разделять числа запятыми, пробелами или переводами строк.',
      'Выбери любой формат, в котором границы каждого целого числа ясны.',
    ],
    start:
      'Начни сразу с первого выбранного значения, не повторяя количество, диапазон или условия задачи перед рядом чисел.',
  },
};

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function createChallengeEntropy(seedHex) {
  if (typeof seedHex !== 'string' || !/^[a-f0-9]{64}$/.test(seedHex)) {
    throw new Error('challenge-invalid: seed must be 64 lowercase hex chars');
  }
  const cipher = crypto.createCipheriv(
    'aes-256-ctr',
    Buffer.from(seedHex, 'hex'),
    Buffer.alloc(16)
  );
  const bytes = Buffer.concat([cipher.update(Buffer.alloc(4096)), cipher.final()]);
  let offset = 0;

  function take(length) {
    if (offset + length > bytes.length) throw new Error('challenge-entropy exhausted');
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    return slice;
  }

  function nextUint32() {
    return take(4).readUInt32LE(0);
  }

  function randomUuid() {
    const source = Buffer.from(take(16));
    source[6] = (source[6] & 0x0f) | 0x40;
    source[8] = (source[8] & 0x3f) | 0x80;
    const h = source.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function randomIndex(length) {
    const limit = Math.floor(0x100000000 / length) * length;
    while (true) {
      const val = nextUint32();
      if (val < limit) return val % length;
    }
  }

  function choose(values) {
    return values[randomIndex(values.length)];
  }

  return { nextUint32, randomUuid, randomIndex, choose };
}

export function generateChallengeSet({
  seed = null,
  schema = CHALLENGE_SCHEMA,
  count = 3,
  usedLengths = [],
} = {}) {
  const actualSeed = seed || crypto.randomBytes(32).toString('hex');
  if (schema !== FIVE_LANGUAGE_SCHEMA && schema !== CHALLENGE_SCHEMA) {
    throw new Error('challenge-invalid');
  }
  const entropy = createChallengeEntropy(actualSeed);
  const legacy = schema === FIVE_LANGUAGE_SCHEMA;
  const identity = legacy ? FIVE_LANGUAGE_IDENTITY : RANDOM_IDENTITY;
  const templates = Object.values(
    legacy ? MD_BASE_LANGUAGES : { ...MD_BASE_LANGUAGES, ...MD_EXTRA_LANGUAGES }
  );

  const usedSet = new Set(usedLengths);
  const available = [];
  for (let i = 0; i < 41; i += 1) {
    const len = 292 + i;
    if (!usedSet.has(len)) available.push(len);
  }

  const lengths = [];
  while (lengths.length < count) {
    const idx = entropy.randomIndex(available.length);
    lengths.push(available.splice(idx, 1)[0]);
  }

  const questions = lengths.map((length, index) => {
    const language = entropy.choose(templates);
    const id = `probe-${index + 1}-${entropy.randomUuid()}`;
    const opening = entropy.choose(language.openings);
    const action = entropy.choose(language.actions);
    const req = language.request(action, length);
    const rules = language.rules;
    const ending = entropy.choose(language.endings);
    const separator = entropy.choose(language.separators);
    const start = language.start;
    return {
      id,
      language: language.code,
      languageLabel: language.label,
      expected_count: length,
      prompt: [opening, req, rules, ending, separator, start].join(language.space),
    };
  });

  const challengeHash = sha256Hex(Buffer.from(`${identity.rulesHash}:${actualSeed}`, 'utf8'));
  return {
    challenge: { schema, seed: actualSeed },
    challengeHash,
    identity,
    questions,
  };
}

// ---------------------------------------------------------------------------
// 2. 纯 Node ZIP 解包与 data/detector.bin 解码
// ---------------------------------------------------------------------------

export function readZipEntries(zipBuffer) {
  const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
  let eocdOffset = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('损坏的内置指纹包（找不到 ZIP 目录尾）');
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralOffset = buf.readUInt32LE(eocdOffset + 16);
  const out = new Map();
  let ptr = centralOffset;

  for (let idx = 0; idx < entryCount; idx += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('损坏的内置指纹包（ZIP 中央目录异常）');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('损坏的内置指纹包（ZIP 本地头异常）');
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      out.set(name, Buffer.from(rawSlice));
    } else if (method === 8) {
      out.set(name, zlib.inflateRawSync(rawSlice));
    } else {
      throw new Error(`不支持的 ZIP 压缩方式: ${method}`);
    }
  }
  return out;
}

export function decodeDetector(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const headerLength = data.readUInt32LE(0);
  const start = Math.ceil((4 + headerLength) / 4) * 4;
  const count = (data.length - start) / 4;
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('detector.bin 长度不合法');
  }

  const raw = new Uint8Array(count * 4);
  const b0 = start;
  const b1 = start + count;
  const b2 = start + count * 2;
  const b3 = start + count * 3;
  for (let i = 0; i < count; i += 1) {
    const p = i * 4;
    raw[p] = data[b0 + i];
    raw[p + 1] = data[b1 + i];
    raw[p + 2] = data[b2 + i];
    raw[p + 3] = data[b3 + i];
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const floats = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    floats[i] = view.getFloat32(i * 4, true);
  }

  const headerText = data.subarray(4, 4 + headerLength).toString('utf8');
  return JSON.parse(headerText, (_key, value) =>
    value && typeof value === 'object' && '$f32' in value
      ? Array.from(floats.subarray(value.$f32, value.$f32 + value.n))
      : value
  );
}

// ---------------------------------------------------------------------------
// 3. 数学特征提取与双引擎评分器
// ---------------------------------------------------------------------------

function mdCanonical(model) {
  return model === 'gpt-6.1-sol' ? MD_MERGED_GROUP_ID : model;
}

function mdDisplayLabel(model) {
  return mdCanonical(model) === MD_MERGED_GROUP_ID ? 'gpt-6-astra / gpt-6.1-sol' : model;
}

export function parseNumbers(text) {
  const s = String(text ?? '');
  const runs = [];
  let current = [];
  let previousEnd = 0;
  for (const match of s.matchAll(/\d+/g)) {
    const separator = s.slice(previousEnd, match.index);
    const value = Number(match[0]);
    if (current.length && /\p{L}/u.test(separator)) {
      runs.push(current);
      current = [];
    }
    if (value >= MD_VALUE_MIN && value <= MD_VALUE_MAX) current.push(value);
    previousEnd = match.index + match[0].length;
  }
  if (current.length) runs.push(current);
  return runs.reduce((best, run) => (run.length > best.length ? run : best), []);
}

export function countNumbers(numbers) {
  const counts = Array(MD_DIMENSION).fill(0);
  for (let i = 0; i < numbers.length; i += 1) {
    counts[numbers[i] - MD_VALUE_MIN] += 1;
  }
  return counts;
}

function mdMean(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return sum / values.length;
}

function mdDot(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) sum += left[i] * right[i];
  return sum;
}

function mdNormVec(values) {
  const n = Math.max(Math.sqrt(mdDot(values, values)), 1e-12);
  return values.map((x) => x / n);
}

function mdZScore(values) {
  const m = mdMean(values);
  let varSum = 0;
  for (let i = 0; i < values.length; i += 1) varSum += (values[i] - m) ** 2;
  const s = Math.max(Math.sqrt(varSum / values.length), 1e-12);
  return values.map((x) => (x - m) / s);
}

function mdColumnMean(matrix) {
  return matrix[0].map((_, i) => mdMean(matrix.map((row) => row[i])));
}

function mdMedian(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mdSubtractSequential(values, basis) {
  const output = values.slice();
  for (const vector of basis || []) {
    const projection = mdDot(output, vector);
    for (let i = 0; i < output.length; i += 1) output[i] -= projection * vector[i];
  }
  return output;
}

function mdSubtractParallel(values, basis) {
  const coefficients = basis.map((row) => mdDot(values, row));
  return values.map((x, i) => {
    let sum = 0;
    for (let j = 0; j < basis.length; j += 1) sum += coefficients[j] * basis[j][i];
    return x - sum;
  });
}

function mdHellingerFeature(counts) {
  const total = counts.reduce((sum, value) => sum + value, 0) + MD_ALPHA * MD_DIMENSION;
  return counts.map((value) => Math.sqrt((value + MD_ALPHA) / total));
}

function mdSplitIntoFour(values) {
  const base = Math.floor(values.length / 4);
  const remainder = values.length % 4;
  const chunks = [];
  let start = 0;
  for (let i = 0; i < 4; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    chunks.push(values.slice(start, start + size));
    start += size;
  }
  return chunks;
}

function mdOrderedBlockFeature(numbers) {
  const pieces = [];
  for (const chunk of mdSplitIntoFour(numbers)) {
    const bins = Array(16).fill(0.5);
    for (const value of chunk) {
      const idx = Math.min(15, Math.floor(((value - 1) / 355) * 16));
      bins[idx] += 1;
    }
    const total = bins.reduce((sum, value) => sum + value, 0);
    pieces.push(...bins.map((value) => Math.sqrt(value / total)));
  }
  const lastDigits = Array(10).fill(0.5);
  for (let i = 0; i < numbers.length; i += 1) lastDigits[numbers[i] % 10] += 1;
  const lastTotal = lastDigits.reduce((sum, value) => sum + value, 0);
  pieces.push(...lastDigits.map((value) => Math.sqrt(value / lastTotal)));
  return pieces;
}

function mdFraction(length, predicate) {
  let hits = 0;
  for (let i = 0; i < length; i += 1) if (predicate(i)) hits += 1;
  return hits / length;
}

function mdPositionKernel(x) {
  const n = x.length;
  const out = Array(34 * 3).fill(0);
  x.forEach((value, position) => {
    const t = ((position + 0.5) * 2) / n - 1;
    const basis = [t, 0.5 * (3 * t * t - 1), 0.5 * (5 * t ** 3 - 3 * t)];
    const features = [
      ...MD_CENTRES.map((centre) => Math.exp(-0.5 * ((value - centre) / 20) ** 2)),
      ...Array.from({ length: 10 }, (_, digit) => (digit === value % 10 ? 1 : 0)),
    ];
    features.forEach((weight, k) => {
      if (!weight) return;
      basis.forEach((b, j) => {
        out[k * 3 + j] += (weight * b) / n;
      });
    });
  });
  return out;
}

function mdCentredTransitions(symbols, bins) {
  const joint = Array(bins * bins).fill(0.5);
  const total = symbols.length - 1 + 0.5 * bins * bins;
  for (let i = 1; i < symbols.length; i += 1) joint[symbols[i - 1] * bins + symbols[i]] += 1;
  for (let i = 0; i < joint.length; i += 1) joint[i] /= total;
  const rows = Array.from({ length: bins }, (_, a) =>
    joint.slice(a * bins, a * bins + bins).reduce((s, v) => s + v, 0)
  );
  const columns = Array.from({ length: bins }, (_, b) =>
    rows.reduce((s, _, a) => s + joint[a * bins + b], 0)
  );
  return joint.map((value, i) => value - rows[Math.floor(i / bins)] * columns[i % bins]);
}

function mdSequenceFeatures(x) {
  const n = x.length;
  const m = mdMean(x);
  const sd = Math.max(Math.sqrt(mdMean(x.map((v) => (v - m) ** 2))), 1);
  const s = x.map((v) => (v - m) / sd);
  const out = [];
  for (const lag of MD_LAGS) {
    const count = n - lag;
    const d = Array.from({ length: count }, (_, i) => x[i + lag] - x[i]);
    out.push(
      mdMean(d.map((_, i) => s[i + lag] * s[i])),
      mdMean(d.map(Math.abs)) / 355,
      mdFraction(count, (i) => d[i] > 0),
      mdFraction(count, (i) => d[i] === 0),
      mdFraction(count, (i) => Math.abs(d[i]) <= 5),
      mdFraction(count, (i) => Math.abs(d[i]) <= 20)
    );
  }
  out.push(...mdCentredTransitions(x.map((v) => Math.min(7, Math.floor(((v - 1) * 8) / 355))), 8));
  out.push(...mdCentredTransitions(x.map((v) => v % 10), 10));
  const difference = Array.from({ length: n - 1 }, (_, i) => x[i + 1] - x[i]);
  const zStep = Array.from({ length: n - 1 }, (_, i) => Math.abs(s[i + 1] - s[i]));
  out.push(
    mdFraction(n - 2, (i) => Math.sign(difference[i + 1]) === Math.sign(difference[i])),
    mdFraction(n - 2, (i) => difference[i + 1] === difference[i]),
    mdFraction(n - 1, (i) => x[i] % 10 === x[i + 1] % 10),
    mdFraction(n - 1, (i) => zStep[i] > 1),
    mdFraction(n - 1, (i) => zStep[i] > 2)
  );
  const buckets = x.map((v) => Math.min(15, Math.floor(((v - 1) * 16) / 355)));
  for (const width of [4, 8, 16]) {
    let sum = 0;
    for (let i = 0; i + width <= n; i += 1) {
      sum += new Set(buckets.slice(i, i + width)).size / width;
    }
    out.push(sum / (n - width + 1));
  }
  return out;
}

function mdPositionalFeatures(numbers) {
  return [
    mdHellingerFeature(countNumbers(numbers)),
    mdOrderedBlockFeature(numbers),
    mdPositionKernel(numbers),
    mdSequenceFeatures(numbers),
  ];
}

function mdPositionalDecision(numbers, head) {
  const parts = mdPositionalFeatures(numbers);
  const x = parts.flatMap((block, j) => {
    const p = head.params[j];
    const scaled = block.map((v, i) => (v - p.mean[i]) / p.scale[i]);
    const length = Math.max(Math.sqrt(scaled.reduce((sum, v) => sum + v * v, 0)), 1e-12);
    const w = Math.sqrt(MD_POSITIONAL_WEIGHTS[j]);
    return scaled.map((v) => (v / length) * w);
  });
  return head.weights.map((row, k) => mdDot(row, x) + head.bias[k]);
}

const mdReferenceNorms = new WeakMap();

function mdNearest(x, references) {
  let norms = mdReferenceNorms.get(references);
  if (!norms) {
    norms = references.map((r) => mdDot(r, r));
    mdReferenceNorms.set(references, norms);
  }
  const xx = mdDot(x, x);
  const dists = references
    .map((r, i) => Math.max(0, xx + norms[i] - 2 * mdDot(x, r)))
    .sort((a, b) => a - b);
  return mdMean(dists.slice(0, 7));
}

function mdBlocks(n) {
  return [mdHellingerFeature(countNumbers(n)), mdOrderedBlockFeature(n)];
}

function mdTransformBlocks(b, params) {
  return b.flatMap((v, j) => {
    const normed = mdNormVec(v.map((x, i) => (x - params[j].mean[i]) / params[j].scale[i]));
    const scale = Math.sqrt(j === 0 ? 0.75 : 0.25);
    return normed.map((x) => x * scale);
  });
}

function mdCentered(v, p) {
  return v.map((x, i) => (x - p.feature_mean[i]) / p.feature_scale[i]);
}

function mdBaseline(b, bank) {
  const h = bank.hellinger;
  const o = bank.ordered_blocks;
  const hUnit = mdNormVec(mdSubtractParallel(mdCentered(b[0], h), h.nuisance_basis));
  const marginal = h.centroids.map((row) => mdDot(hUnit, row));
  const oCentered = mdCentered(b[1], o);
  const raw = mdNormVec(oCentered);
  const projected = mdNormVec(mdSubtractParallel(oCentered, o.nuisance_basis));
  const templates = o.centroids.map((_, i) =>
    Math.max(...o.environment_centroids.map((rows) => mdDot(raw, rows[i])))
  );
  const nuisance = o.centroids.map((row) => mdDot(projected, row));
  const tz = mdZScore(templates);
  const nz = mdZScore(nuisance);
  const ordered = mdZScore(tz.map((v, i) => 0.5 * v + 0.5 * nz[i]));
  const mz = mdZScore(marginal);
  return mz.map((v, i) => 0.5 * v + 0.5 * ordered[i]);
}

export function supportsSharedDetector(bank, artifact) {
  return (
    artifact?.schema === 'shared-detector-v2' &&
    bank?.built_at === artifact.bank_built_at &&
    Array.isArray(bank?.models) &&
    bank.models.length === artifact.model_ids?.length &&
    bank.models.every(
      (m, i) => m.id === artifact.model_ids[i] && m.response_count === artifact.response_counts[i]
    )
  );
}

export function calibrateRanking(ranking, artifact) {
  const head = artifact.calibration;
  const binding = head?.binding;
  if (
    !head ||
    !binding ||
    head.schema !== 'shared-confidence-v2' ||
    head.method !== 'ranking-temperature' ||
    !Number.isFinite(head.tau) ||
    head.tau < 0.001 ||
    head.tau > 1000 ||
    binding.base_sha256 !== artifact.base_sha256 ||
    binding.reference_sha256 !== artifact.source_reference_sha256 ||
    binding.model_ids.length !== ranking.length ||
    ranking.length !== artifact.model_ids.length ||
    !ranking.every(Number.isFinite) ||
    !binding.model_ids.every((id, i) => id === artifact.model_ids[i])
  ) {
    return null;
  }
  const logits = ranking.map((score) => head.tau * score);
  const maximum = Math.max(...logits);
  const weights = logits.map((value) => Math.exp(value - maximum));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((value) => value / sum);
}

export function rankSharedNumbers(numbers, artifact) {
  const a = artifact.ranker;
  const full = numbers.map(mdBlocks);
  const ax = full.map((b) => mdTransformBlocks(b, a.full_params));
  const lda = numbers.map((n) => {
    const x = mdTransformBlocks(mdBlocks(n.slice(0, 128)), a.head_params);
    return mdZScore(a.lda_weights.map((row, i) => mdDot(row, x) + a.lda_bias[i]));
  });
  const l = mdZScore(mdColumnMean(lda));
  const near = mdZScore(a.references.map((ref) => mdMedian(ax.map((x) => -mdNearest(x, ref)))));
  const base = mdZScore(mdColumnMean(full.map((b) => mdBaseline(b, a.bank))));
  const frequency = mdZScore(l.map((x, i) => 0.5 * x + 0.25 * near[i] + 0.25 * base[i]));
  const positional = mdZScore(
    mdColumnMean(numbers.map((n) => mdZScore(mdPositionalDecision(n, a.positional))))
  );
  const ranking = frequency.map((x, i) => a.blend.frequency * x + a.blend.positional * positional[i]);
  if (!ranking.every(Number.isFinite)) {
    throw new Error('排名计算产生无效数值，请重试');
  }
  return ranking;
}

export function sequenceShape(numbers) {
  const shapes = numbers.map((n) => {
    const m = mdMean(n);
    const variance = mdMean(n.map((x) => (x - m) ** 2));
    const steps = n.slice(1).map((x, i) => x - n[i]);
    return {
      autocorrelation: variance
        ? mdMean(steps.map((_, i) => (n[i + 1] - m) * (n[i] - m))) / variance
        : 1,
      small_step_share: mdMean(steps.map((d) => (Math.abs(d) <= 20 ? 1 : 0))),
    };
  });
  const autocorrelation = mdMedian(shapes.map((s) => s.autocorrelation));
  const small_step_share = mdMedian(shapes.map((s) => s.small_step_share));
  return {
    autocorrelation,
    small_step_share,
    model_like:
      autocorrelation <= MD_SEQUENCE_LIMITS.autocorrelation ||
      small_step_share <= MD_SEQUENCE_LIMITS.small_step_share,
  };
}

export function analyzeSharedOutputs(outputs, bank, artifact, options = {}) {
  if (!supportsSharedDetector(bank, artifact)) {
    throw new Error('指纹参考库与检测器版本不匹配，请重新检查更新');
  }
  const parsed = outputs.map((o) => parseNumbers(o.text));
  const diagnostics = outputs.map((o, index) => {
    const minimum = Math.max(80, Math.ceil((o.expected_count || 0) * 0.55));
    const raw = Array.from(String(o.text || '').matchAll(/-?\d+/g), (m) => Number(m[0]));
    return {
      index,
      parsed_numbers: parsed[index].length,
      minimum_numbers: minimum,
      accepted: parsed[index].length >= minimum,
      raw_out_of_range_count: raw.filter((n) => n < 1 || n > 355).length,
    };
  });
  const used = diagnostics.filter((d) => d.accepted).length;
  const accepted = parsed.filter((_, i) => diagnostics[i].accepted);
  const sequence = used ? sequenceShape(accepted) : null;
  const common = {
    probability: null,
    probability_status: 'unavailable',
    used_outputs: used,
    diagnostics,
    sequence,
    method: 'shared-detector-v2',
    model_version: { base_sha256: artifact.base_sha256 },
  };
  const notModel = {
    ...common,
    prediction: '',
    prediction_name: '不像语言模型回答',
    family_prediction_name: '',
    results: [],
    decision: 'not_model',
    evidence: {
      insufficient: true,
      label: '不像语言模型回答',
      reason: '相邻数字的变化方式与参考库中的语言模型回答不同，常见于程序随机数或排序后的数字。',
      threshold: null,
      method: 'sequence-shape',
    },
  };

  if (options.allowPartial && used > 0 && used < 3 && outputs.length <= 3) {
    if (!sequence.model_like) return notModel;
    const ranking = rankSharedNumbers(accepted, artifact);
    const order = artifact.model_ids.map((_, i) => i).sort((i, j) => ranking[j] - ranking[i]);
    const results = order.map((i) => ({
      model: artifact.model_ids[i],
      display_name: bank.models[i].display_name,
      family: bank.models[i].family,
      family_name: bank.models[i].family_name,
      score: ranking[i],
      probability: null,
    }));
    const first = order[0];
    return {
      ...common,
      method: 'shared-ranker-partial-v1',
      decision: 'partial',
      prediction: results[0].model,
      prediction_name: results[0].display_name,
      family_prediction: bank.models[first].family,
      family_prediction_name: bank.models[first].family_name,
      results,
      ranking_score: ranking[first],
      calibration: null,
      evidence: {
        insufficient: true,
        label: '部分样本排名',
        reason: `使用 ${used}/3 条有效回答生成排名；补齐三条有效回答后可计算校准置信度。`,
        threshold: null,
        method: 'partial-sample-ranking',
      },
    };
  }

  if (outputs.length !== 3 || used !== 3) {
    return {
      ...common,
      prediction: '',
      prediction_name: '暂不可评分',
      family_prediction_name: '',
      results: [],
      decision: 'unscorable',
      evidence: {
        insufficient: true,
        label: '需要三条完整回答',
        reason: `当前有 ${used}/${outputs.length} 条有效回答，请重试。`,
        threshold: null,
        method: 'complete-three-answers',
      },
    };
  }

  if (!sequence.model_like) return notModel;

  const ranking = rankSharedNumbers(parsed, artifact);
  const probabilities = calibrateRanking(ranking, artifact);
  const order = artifact.model_ids.map((_, i) => i).sort((i, j) => ranking[j] - ranking[i]);
  const results = order.map((i) => ({
    model: artifact.model_ids[i],
    display_name: bank.models[i].display_name,
    family: bank.models[i].family,
    family_name: bank.models[i].family_name,
    score: ranking[i],
    probability: probabilities?.[i] ?? null,
  }));
  const first = order[0];
  return {
    ...common,
    prediction: results[0].model,
    prediction_name: results[0].display_name,
    family_prediction: bank.models[first].family,
    family_prediction_name: bank.models[first].family_name,
    results,
    ranking_score: ranking[first],
    probability: results[0].probability,
    probability_status: probabilities ? 'reference_calibrated' : 'unavailable',
    probability_scope: probabilities ? 'reference-closed-set' : null,
    calibration: probabilities
      ? {
          method: artifact.calibration.method,
          run: artifact.calibration.calibration_run,
          tau: artifact.calibration.tau,
          sha256: artifact.calibration_sha256 ?? null,
        }
      : null,
    evidence: {
      insufficient: true,
      label: probabilities ? '库内校准排名' : '未校准排名',
      reason: probabilities
        ? '置信度是参考库内的闭集相对概率，不包含库外模型。'
        : '校准参数不匹配，仅按排名分数排序。',
      threshold: null,
      method: probabilities ? 'reference-calibrated-ranking' : 'uncalibrated-ranking',
    },
  };
}

function mdRobustScoreCounts(counts, bank) {
  const artifact = bank.robust.hellinger;
  const feature = mdHellingerFeature(counts);
  let projected = feature.map((value, i) => (value - artifact.feature_mean[i]) / artifact.feature_scale[i]);
  projected = mdSubtractSequential(projected, artifact.nuisance_basis);
  projected = mdNormVec(projected);
  return mdZScore(artifact.centroids.map((centroid) => mdDot(projected, centroid)));
}

function mdOrderedBlockScores(numbers, bank) {
  const artifact = bank.robust.ordered_blocks;
  const feature = mdOrderedBlockFeature(numbers);
  const stdFeat = feature.map((value, i) => (value - artifact.feature_mean[i]) / artifact.feature_scale[i]);
  const unit = mdNormVec(stdFeat);
  const environmentScores = artifact.environment_centroids.map((centroids) =>
    centroids.map((centroid) => mdDot(unit, centroid))
  );
  const template = mdZScore(
    artifact.centroids.map((_, modelIndex) =>
      Math.max(...environmentScores.map((scores) => scores[modelIndex]))
    )
  );
  const projected = mdNormVec(mdSubtractSequential(stdFeat, artifact.nuisance_basis));
  const nuisance = mdZScore(artifact.centroids.map((centroid) => mdDot(projected, centroid)));
  return mdZScore(template.map((value, i) => 0.5 * value + 0.5 * nuisance[i]));
}

function mdRobustScoreNumbers(numbers, bank) {
  const marginal = mdRobustScoreCounts(countNumbers(numbers), bank);
  const artifact = bank.robust.ordered_blocks;
  const weight = artifact ? Number(artifact.weight || 0) : 0;
  if (!artifact || weight === 0) return marginal;
  const ordered = mdOrderedBlockScores(numbers, bank);
  return marginal.map((value, i) => (1 - weight) * value + weight * ordered[i]);
}

function mdSoftmax(values) {
  const maximum = Math.max(...values);
  const weights = values.map((value) => Math.exp(value - maximum));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value) => value / total);
}

function mdJsSimilarity(left, right) {
  const leftTotal = left.reduce((sum, value) => sum + value, 0);
  const rightTotal = right.reduce((sum, value) => sum + value, 0) + MD_ALPHA * MD_DIMENSION;
  const p = left.map((value) => value / leftTotal);
  const q = right.map((value) => (value + MD_ALPHA) / rightTotal);
  const midpoint = p.map((value, i) => (value + q[i]) / 2);
  const divergence = (values) =>
    values.reduce((total, value, i) => total + (value ? value * Math.log(value / midpoint[i]) : 0), 0);
  const js = Math.max(0, (divergence(p) + divergence(q)) / 2);
  return 1 - Math.sqrt(js / Math.log(2));
}

export function analyzeGlobalOutputs(outputs, bank) {
  const modelIds = bank.models.map((m) => m.id);
  const valid = [];
  const diagnostics = [];
  outputs.forEach((item, index) => {
    const expected = Number(item.expected_count || 0);
    const numbers = parseNumbers(item.text || '');
    const minimum = expected ? Math.max(80, Math.ceil(expected * 0.55)) : 80;
    const accepted = numbers.length >= minimum;
    diagnostics.push({ index, parsed_numbers: numbers.length, minimum_numbers: minimum, accepted });
    if (accepted) {
      valid.push({ numbers, counts: countNumbers(numbers), scores: mdRobustScoreNumbers(numbers, bank) });
    }
  });
  if (!valid.length) {
    throw new Error('模型没有返回足够长的有效整数序列（可能触发了拒答或输出被截断）');
  }

  const combinedScores = modelIds.map((_, modelIndex) =>
    mdMean(valid.map((item) => item.scores[modelIndex]))
  );
  const calKey = String(Math.min(valid.length, 3));
  const beta = Number(bank.calibration[calKey].beta);
  const probabilities = mdSoftmax(combinedScores.map((v) => beta * v));
  const pooledCounts = Array.from({ length: MD_DIMENSION }, (_, i) =>
    valid.reduce((sum, item) => sum + item.counts[i], 0)
  );
  const modelEntries = Object.fromEntries(bank.models.map((m) => [m.id, m]));
  const familyOrder = [...new Set(bank.models.map((m) => m.family || 'models'))];
  const familyNames = Object.fromEntries(
    familyOrder.map((fam) => [
      fam,
      bank.models.find((m) => (m.family || 'models') === fam)?.family_name || fam,
    ])
  );
  const results = modelIds
    .map((model, idx) => ({
      model,
      display_name: modelEntries[model].display_name,
      probability: probabilities[idx],
      profile_similarity: mdJsSimilarity(pooledCounts, modelEntries[model].counts),
      score: combinedScores[idx],
      family: modelEntries[model].family || 'models',
      family_name: familyNames[modelEntries[model].family || 'models'],
    }))
    .sort((a, b) => b.probability - a.probability);
  const familyProbabilities = Object.fromEntries(
    familyOrder.map((fam) => [
      fam,
      results.filter((item) => item.family === fam).reduce((sum, item) => sum + item.probability, 0),
    ])
  );
  results.forEach((item) => {
    item.conditional_probability = item.probability / familyProbabilities[item.family];
  });
  const winningFamily = familyOrder.reduce((best, fam) =>
    familyProbabilities[fam] > familyProbabilities[best] ? fam : best
  );
  return {
    prediction: results[0].model,
    prediction_name: results[0].display_name,
    probability: results[0].probability,
    used_outputs: valid.length,
    results,
    diagnostics,
    calibration: { queries: calKey, beta, cv_accuracy: bank.calibration[calKey].cv_accuracy },
    family_prediction: winningFamily,
    family_prediction_name: familyNames[winningFamily],
    family_probability: familyProbabilities[winningFamily],
    family_probabilities: familyOrder.map((fam) => ({
      family: fam,
      display_name: familyNames[fam],
      probability: familyProbabilities[fam],
    })),
    method: '统一全局稳健数字指纹',
  };
}

// ---------------------------------------------------------------------------
// 4. Antigravity 专属参考对齐与报告构建
// ---------------------------------------------------------------------------

const MD_RELEASE_DATE_RE = /[-_.]?(?:20\d{2}[-_.]?\d{2}[-_.]?\d{2}|2\d[01]\d[0-3]\d)$/;
const MD_TAG_PREFIX_RE = /^(?:\[[^\]]*\]|【[^】]*】)\s*/u;
const MD_EFFORT_TIER_SUFFIX_RE = /-(?:xhigh|high|medium|low|minimal|thinking|fast)$/i;

export function normalizeDetectorModelId(id) {
  if (typeof id !== 'string') return '';
  let value = id.trim().toLowerCase().replace(MD_TAG_PREFIX_RE, '');
  const atIndex = value.indexOf('@');
  if (atIndex > 0) value = value.slice(0, atIndex).trim();
  value = value
    .slice(value.lastIndexOf('/') + 1)
    .replace(/_/g, '-')
    .replace(MD_RELEASE_DATE_RE, '');
  while (/\d-\d/.test(value)) {
    value = value.replace(/(\d)-(\d)/g, '$1.$2');
  }
  return value;
}

function stripAntigravityTierSuffix(normalizedId) {
  let cur = String(normalizedId || '').trim();
  for (let i = 0; i < 2; i += 1) {
    const next = cur.replace(MD_EFFORT_TIER_SUFFIX_RE, '');
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/**
 * 将 Antigravity 的 `modelId` / `label` 映射至指纹库中已收录的标准模型 ID。
 *
 * 覆盖规则：
 * - 直接精确匹配（如库内已直接收录对应 ID）；
 * - Orchestrator 系列包装模型（`gemini-pro-orchestrator` -> `gemini-4-carbon`，`gemini-pro-orchestrator-argon` -> `gemini-4-argon`，以及未来 `Orchestrator (<Variant>)` -> `gemini-4-<variant>`）；
 * - 思考档位后缀剥离（如 `gemini-4-carbon-high` -> `gemini-4-carbon`，`claude-opus-5-5-medium` -> `claude-opus-5.5`）；
 * - 若指纹库暂未收录（如上游更新前的全新代号），返回 `null` 进入开放世界最接近家族识别模式，上游自动更新收录后无需改代码即可自动对齐。
 *
 * @param {string} modelId
 * @param {string[]} choices
 * @param {string} [label='']
 * @returns {string|null}
 */
export function suggestAntigravityReference(modelId, choices, label = '') {
  const key = normalizeDetectorModelId(modelId);
  const list = Array.isArray(choices) ? choices.filter((id) => id && id !== 'unknown') : [];
  if (!key || !list.length) return null;

  const findNormalized = (candidate) => {
    const normCand = normalizeDetectorModelId(candidate);
    if (!normCand) return null;
    return list.find((id) => normalizeDetectorModelId(id) === normCand) || null;
  };

  const exact = findNormalized(key);
  if (exact) return exact;

  // Orchestrator 系列底层基座对齐
  if (key === 'gemini-pro-orchestrator') {
    const hit = findNormalized('gemini-4-carbon');
    if (hit) return hit;
  } else if (key.startsWith('gemini-pro-orchestrator-')) {
    const variant = stripAntigravityTierSuffix(key.slice('gemini-pro-orchestrator-'.length));
    if (variant) {
      const hit = findNormalized(`gemini-4-${variant}`) || findNormalized(variant);
      if (hit) return hit;
    }
  }
  const orchLabelMatch = String(label || '').match(/orchestrator\s*\(\s*([a-z0-9._-]+)\s*\)/i);
  if (orchLabelMatch) {
    const variant = orchLabelMatch[1].toLowerCase();
    const hit = findNormalized(`gemini-4-${variant}`) || findNormalized(variant);
    if (hit) return hit;
  }

  // 剥离 Antigravity 思考强度档位后缀（-xhigh / -high / -medium / -low）
  const stripped = stripAntigravityTierSuffix(key);
  if (stripped && stripped !== key) {
    const tierHit = findNormalized(stripped);
    if (tierHit) return tierHit;
  }

  return null;
}

function isSameLineageCheckpoint(refId, topId) {
  if (!refId || !topId) return false;
  const clean = (s) =>
    normalizeDetectorModelId(s)
      .replace(/-\d{4}$/, '')
      .replace(/(\d+)\.\d+/, '$1');
  return clean(refId) === clean(topId);
}

function mdPrepareOutputsForPrimary(outputs) {
  const diagnostics = outputs.map((o) => {
    const count = parseNumbers(o.text).length;
    const expected = o.expected_count;
    const minimum = Math.max(80, Math.ceil(expected * 0.55));
    return {
      parsed: count,
      expected,
      minimum,
      primary_used: Math.min(count, expected),
      extra: Math.max(0, count - expected),
    };
  });
  const prepared = outputs.map((o, i) => {
    const d = diagnostics[i];
    if (d.parsed < d.minimum) return { ...o, text: '' };
    if (d.extra > 0) {
      return { ...o, text: parseNumbers(o.text).slice(0, o.expected_count).join(', ') };
    }
    return o;
  });
  return { diagnostics, prepared };
}

function mdSimilarityScores(outputs, engine, primaryTop) {
  const { prepared } = mdPrepareOutputsForPrimary(outputs);
  const shared = analyzeSharedOutputs(prepared, engine.primary, engine.detector, {
    allowPartial: true,
  });
  const best = new Map();
  for (const item of shared.results || []) {
    const id = mdCanonical(item.model);
    if (Number.isFinite(item.score) && !(best.get(id) >= item.score)) {
      best.set(id, item.score);
    }
  }
  const scores = [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, score]) => ({ model, score: Math.round(score * 100) / 100 }));
  return scores[0]?.model === primaryTop[0] ? scores : [];
}

function mdScoreV1Outputs(outputs, engine, rulesVersion, rulesHash) {
  const { diagnostics, prepared } = mdPrepareOutputsForPrimary(outputs);
  const first = analyzeSharedOutputs(prepared, engine.primary, engine.detector, {
    allowPartial: true,
  });
  const second = analyzeGlobalOutputs(outputs, engine.secondary);
  const primary = (first.results || []).slice(0, 3).map((r) => r.model);
  const supplemental = (second.results || []).slice(0, 3).map((r) => r.model);
  const candidates = primary.length
    ? [...new Set([...primary, ...supplemental].map(mdCanonical))]
    : [];
  return {
    sharedDetail: first,
    supplementalDetail: second,
    reportCore: {
      decision: candidates.length ? 'candidates' : 'insufficient',
      primaryDecision: first.decision || 'scored',
      primary,
      supplemental,
      candidates,
      disagreement: Boolean(
        primary.length && supplemental.length && mdCanonical(primary[0]) !== mdCanonical(supplemental[0])
      ),
      diagnostics,
      sequence: first.sequence,
      usedOutputs: first.used_outputs,
      rulesVersion,
      rulesHash,
      referenceHash: engine.detectorSha256,
    },
  };
}

export function compareReference(result, reference) {
  if (!reference || reference === 'unknown') return { state: 'unset', rank: 0 };
  const ranked = result?.primary ?? [];
  if (!ranked.length) return { state: 'undetermined', rank: 0 };
  const rank = ranked.indexOf(mdCanonical(reference)) + 1;
  return { state: rank === 1 ? 'match' : rank > 1 ? 'near' : 'mismatch', rank };
}

export function unresolvedCandidates(result) {
  const ranked = result?.primary;
  return Array.isArray(ranked) &&
    GEMINI4_PAIR.includes(ranked[0]) &&
    GEMINI4_PAIR.every((id) => ranked.slice(0, 3).includes(id))
    ? [...GEMINI4_PAIR]
    : [];
}

export function compareForDisplay(result, reference) {
  const comparison = compareReference(result, reference);
  const unresolved = unresolvedCandidates(result);
  return unresolved.length &&
    reference &&
    reference !== 'unknown' &&
    unresolved.includes(mdCanonical(reference))
    ? { ...comparison, state: 'ambiguous' }
    : comparison;
}

export function buildPrimaryJsonFromUnifiedBank(unifiedBank) {
  if (!unifiedBank || typeof unifiedBank !== 'object' || !Array.isArray(unifiedBank.models)) {
    throw new Error('上游 unified_bank.json 格式不合法');
  }
  return {
    built_at: String(unifiedBank.built_at || ''),
    models: unifiedBank.models.map((m) => ({
      id: m.id,
      display_name: m.display_name || m.id,
      family: m.family,
      family_name: m.family_name,
      response_count: m.response_count,
    })),
  };
}

export function formatDiagnosisSummary({
  claimed,
  claimedLabel = '',
  reference,
  topCandidate,
  displayVerdict,
  unresolved,
  sharedDecision,
}) {
  const displayClaimed = claimedLabel || claimed;
  if (sharedDecision === 'not_model') {
    return {
      badge: '异常序列',
      tone: 'bad',
      headline: '回答不像语言模型直觉生成',
      detail: '相邻整数分布更接近外部程序随机数或规则化序列，未生成模型排名。',
    };
  }
  if (!topCandidate) {
    return {
      badge: '样本不足',
      tone: 'warn',
      headline: '有效数字不足，暂时无法判定',
      detail: '请重试一次，确认模型返回了完整的数字序列。',
    };
  }
  const topLabel = mdDisplayLabel(topCandidate.model);
  const state = displayVerdict?.state || 'unset';
  if (state === 'match') {
    return {
      badge: '真身一致',
      tone: 'ok',
      headline: `验证通过：确认为 ${topLabel}`,
      detail: `响应指纹与参考库中的 ${reference} 排名第 1 吻合。`,
    };
  }
  if (state === 'ambiguous') {
    const pairText = unresolved.join(' / ');
    return {
      badge: '同源相近',
      tone: 'ok',
      headline: `命中 Gemini 4 同源指纹（首选 ${topLabel}）`,
      detail: `${pairText} 同属同代近亲模型，当前分布首推 ${topLabel}。`,
    };
  }
  if (state === 'near') {
    return {
      badge: '近亲吻合',
      tone: 'warn',
      headline: `最接近 ${topLabel}（对标模型排第 ${displayVerdict.rank}）`,
      detail: `参考库中 ${reference} 进入前三候选，常见于不同思考档位或小版本权重波动。`,
    };
  }
  if (state === 'mismatch') {
    if (isSameLineageCheckpoint(reference, topCandidate.model)) {
      return {
        badge: '同系新版',
        tone: 'info',
        headline: `实测为同系列迭代权重 ${topLabel}`,
        detail: `所选模型为 ${displayClaimed || reference}，底层权重分布更接近同代版本 ${topLabel}。`,
      };
    }
    return {
      badge: '指纹不符',
      tone: 'bad',
      headline: `实测最接近 ${topLabel}`,
      detail: `所选为 ${displayClaimed || reference}（对标 ${reference}），但未进入指纹前三候选。`,
    };
  }
  const claimedNote = displayClaimed ? `「${displayClaimed}」暂未单独收录进参考库，` : '';
  return {
    badge: '指纹识别',
    tone: 'neutral',
    headline: `响应指纹最接近 ${topLabel}`,
    detail: `${claimedNote}在 ${topCandidate.familyName || topCandidate.family} 等已收录模型中最接近 ${topLabel}。`,
  };
}

export function buildEngineFromBuffers(filesMap, { source = 'builtin' } = {}) {
  const getBuf = (name) => {
    const buf = filesMap instanceof Map ? filesMap.get(name) : filesMap?.[name];
    if (!buf) throw new Error(`指纹库缺少文件: ${name}`);
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  };

  const manifest = JSON.parse(getBuf('asset-manifest.json').toString('utf8'));
  for (const rel of REQUIRED_BANK_ASSETS) {
    const expectedSha = manifest?.assets?.[rel]?.sha256;
    const raw = getBuf(rel);
    if (expectedSha) {
      const actualSha = sha256Hex(raw);
      if (actualSha !== expectedSha) {
        throw new Error(
          `指纹库校验失败 (${rel}): ${actualSha.slice(0, 12)} != ${expectedSha.slice(0, 12)}`
        );
      }
    }
  }

  const detectorBuf = getBuf('data/detector.bin');
  const detector = decodeDetector(detectorBuf);
  const primary = JSON.parse(getBuf('data/primary.json').toString('utf8'));
  const secondary = JSON.parse(getBuf('data/modeltrace.json').toString('utf8'));
  const rules = JSON.parse(getBuf('rules.json').toString('utf8'));

  if (!supportsSharedDetector(primary, detector)) {
    throw new Error('primary.json 与 detector.bin 模型列表不一致');
  }

  const mergedMembers = Array.isArray(rules?.merged_group?.members)
    ? rules.merged_group.members
    : [];
  const modelChoices = [
    ...new Set(['unknown', ...primary.models.map((m) => m.id), ...mergedMembers]),
  ];

  return {
    source,
    manifest,
    detector,
    primary,
    secondary,
    rules,
    detectorSha256: manifest?.assets?.['data/detector.bin']?.sha256 || sha256Hex(detectorBuf),
    builtAt: primary.built_at || '',
    modelCount: primary.models.length,
    families: [...new Set(primary.models.map((m) => m.family_name || m.family))],
    modelChoices,
  };
}

export function buildFullDiagnosis({
  replies,
  claimed = '',
  claimedLabel = '',
  seed = null,
  schema = CHALLENGE_SCHEMA,
  questions = null,
  engine,
}) {
  if (!Array.isArray(replies) || replies.length < 1 || replies.length > 3) {
    throw new Error('需要提供 1 至 3 条探针回答');
  }
  const challengeSet = questions
    ? {
        challenge: { schema, seed: seed || '' },
        challengeHash: '',
        identity: schema === FIVE_LANGUAGE_SCHEMA ? FIVE_LANGUAGE_IDENTITY : RANDOM_IDENTITY,
        questions,
      }
    : generateChallengeSet({ seed, schema });

  const outputs = replies.map((text, i) => ({
    text: String(text ?? ''),
    expected_count: challengeSet.questions[i]?.expected_count || 300,
  }));

  const { sharedDetail, reportCore } = mdScoreV1Outputs(
    outputs,
    engine,
    challengeSet.identity.rulesVersion,
    challengeSet.identity.rulesHash
  );

  const primary = reportCore.primary.map(mdCanonical);
  const supplemental = reportCore.supplemental.map(mdCanonical);
  const secIds = new Set(engine.secondary.models.map((m) => mdCanonical(m.id)));

  const result = {
    ...reportCore,
    primary,
    supplemental,
    diagnostics: reportCore.diagnostics.map((d) => ({
      ...d,
      used: d.primary_used,
      accepted: d.parsed >= d.minimum,
    })),
    coverage: {
      status: !primary.length
        ? 'not-ranked'
        : secIds.has(primary[0])
          ? 'shared-reference'
          : 'not-enrolled',
      missingPrimary: primary.filter((m) => !secIds.has(m)),
    },
    similarity: primary.length ? mdSimilarityScores(outputs, engine, primary) : [],
    protocol: RANDOM_IDENTITY.protocol,
  };

  const reference = claimed
    ? suggestAntigravityReference(claimed, engine.modelChoices, claimedLabel)
    : null;
  const verdict = compareReference(result, reference);
  const unresolved = unresolvedCandidates(result);
  const displayVerdict = compareForDisplay(result, reference);

  const topCandidates = [];
  const seenCanonical = new Set();
  for (const item of sharedDetail.results || []) {
    const id = mdCanonical(item.model);
    if (seenCanonical.has(id)) continue;
    seenCanonical.add(id);
    topCandidates.push({
      model: id,
      label: mdDisplayLabel(id),
      family: item.family,
      familyName: item.family_name,
      score: Math.round(item.score * 100) / 100,
      rawScore: item.score,
      probability: Number.isFinite(item.probability) ? item.probability : null,
    });
    if (topCandidates.length >= 5) break;
  }

  const totalNumbers = result.diagnostics.reduce((sum, d) => sum + d.parsed, 0);
  const summary = formatDiagnosisSummary({
    claimed: String(claimed || '').trim(),
    claimedLabel: String(claimedLabel || '').trim(),
    reference,
    topCandidate: topCandidates[0] || null,
    displayVerdict,
    unresolved,
    sharedDecision: sharedDetail.decision,
  });

  return {
    schema: 'modeldial-fingerprint-report-multilingual-v1',
    createdAt: new Date().toISOString(),
    claimed: String(claimed || '').trim(),
    claimedLabel: String(claimedLabel || '').trim(),
    reference: reference || 'unknown',
    verdict,
    displayVerdict,
    unresolvedCandidates: unresolved,
    summary,
    topCandidates,
    totalNumbers,
    usedOutputs: result.usedOutputs,
    partial: sharedDetail.decision === 'partial',
    challenge: challengeSet.challenge,
    challengeHash: challengeSet.challengeHash,
    result,
  };
}

export function diffManifestAssets(localManifest, remoteManifest) {
  const remoteAssets = remoteManifest?.assets;
  if (!remoteAssets || typeof remoteAssets !== 'object') {
    return { valid: false, changed: [], remoteDetectorSha: '' };
  }
  for (const rel of REQUIRED_BANK_ASSETS) {
    const sha = remoteAssets[rel]?.sha256;
    if (typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha)) {
      return { valid: false, changed: [], remoteDetectorSha: '' };
    }
  }
  const localAssets = localManifest?.assets || {};
  const changed = REQUIRED_BANK_ASSETS.filter(
    (rel) => localAssets[rel]?.sha256 !== remoteAssets[rel].sha256
  );
  return {
    valid: true,
    changed,
    remoteDetectorSha: remoteAssets['data/detector.bin'].sha256,
  };
}
