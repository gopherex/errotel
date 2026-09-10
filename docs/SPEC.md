# RFC: App Debug — контракт данных и чтения v0.1

**Дата:** 10 сентября 2026 года.  
**Статус:** проект спецификации для реализации.  
**Версия wire-формата:** 1.  
**Рабочее пространство собственных атрибутов:** `app.debug.*`.

Название App Debug и namespace — технические рабочие имена, не название уже
существующего пакета. Зафиксированные требования продукта перечислены ниже;
конкретные имена методов, полей и предложенные настройки по умолчанию являются
решениями этого RFC. Слова «должен», «не должен» задают ожидаемое поведение
будущей реализации, а не утверждают, что она уже написана.

## 1. Назначение и границы

Продукт помогает браузерному приложению записать ошибку с диагностическим
контекстом через OpenTelemetry, а разработчику — исследовать её в UI поверх
уже существующего VictoriaMetrics-стека.

```
Приложение → browser SDK → OTLP pipeline пользователя → VictoriaLogs
                             │                       → VictoriaTraces
                             └─ существующие сигналы → VictoriaMetrics

UI → наш stateless-сервер → read APIs VM-стека
```

SDK не отправляет телеметрию нашему серверу. Сервер не принимает, не переписывает
и не сохраняет телеметрию, не выполняет фонового индексирования. Источником
данных остаётся инфраструктура пользователя. Кеш сервера только временный;
любые его записи можно удалить без потери продуктовой истины.

Первая версия: browser Window, ручной захват и автоматические обработчики,
динамические источники состояния, контекст одного вызова, локальная история,
исходный stacktrace, список ошибок и экран конкретного возникновения. Ни
Node.js, ни межоконный сбор, ни workers не обещаются этой версией.

Не входят: source maps, загрузка артефактов, собственный ingest, собственная БД,
постоянные Issues со статусами, пользователи/RBAC, session replay, универсальный
query editor, dashboard engine, адаптеры библиотек состояния.

Состав инфраструктуры пользователя: VictoriaLogs + VictoriaTraces +
VictoriaMetrics. Наличие третьего источника не требует автоматически читать
метрики или рисовать графики. Частоту ошибок можно считать в VictoriaLogs.

## 2. Основная единица: одно возникновение ошибки

Одно успешное обращение `captureException` создаёт **один OTEL LogRecord**.
В нём находятся ошибка, текущие снимки и копия удержанной истории. Это не
ссылка на обязательный внешний snapshot, а самодостаточный диагностический
контекст в одной записи.

Связанный trace остаётся самостоятельным сигналом, загружаемым по запросу.
Состояние не живёт внутри Span, Resource или Baggage. Не создаётся фиктивный
span только ради получения идентификатора.

Термины:

| Термин | Смысл |
|---|---|
| Occurrence | Один захват ошибки; для SDK имеет собственный eventId. |
| Runtime | Одна жизнь экземпляра SDK; не пользовательская сессия. |
| State source | Именованная пользовательская функция чтения и сериализации. |
| Registration | Одна регистрация источника; имеет собственную идентичность. |
| Snapshot | Зафиксированный результат одного чтения источника. |
| History entry | Уже материализованное событие или снимок в локальном буфере. |
| Error group | Результат группирующего запроса за интервал, не постоянная запись. |

`eventId` генерируется один раз при захвате и не меняется при повторной отправке.
История, приложенная к двум ошибкам, содержит те же идентификаторы своих ранее
созданных элементов. Повторные доставки не превращаются в новые события.

## 3. Транспорт и формат тела

### 3.1. OTLP

Базовый вариант прямой отправки в VictoriaLogs — **OTLP/HTTP protobuf** с
`Content-Type: application/x-protobuf`. Пользовательский Collector допустим,
но не является компонентом нашего продукта. Browser transport требует
работающих CORS/CSP и доступного принимающего endpoint. [S1][S2][S13]

В проверенном обработчике VictoriaLogs `/insert/opentelemetry/v1/logs` запросы
с JSON content type отклоняются. Поэтому демонстрационный `exception-otlp.json`
— читаемое стандартное представление протокола, а не готовый POST для этого
endpoint. При отправке используется настоящий protobuf exporter. [S2]

```
HTTP request: binary OTLP protobuf
  LogRecord.Body: stringValue
    содержимое строки: JSON диагностического envelope
```

JSON в Body не означает OTLP/JSON на уровне HTTP.

### 3.2. Почему Body — JSON-строка

OTEL разрешает в Body и строку, и структурированный AnyValue. Но проверенный
VictoriaLogs receiver разворачивает map-значения в плоские имена полей; простые
поля возвращаются строками. Это неудобно для точного восстановления произвольного
пользовательского JSON, включая ключи с точками и различение типов. [S4][S5]

Поэтому encoder v1 делает `Body = JSON.stringify(envelope)` после строгой
проверки пользовательских JSON-значений. Для стандартного ingestion эта строка
оказывается в `_msg`; её содержимое сервер декодирует как один JSON-документ.
Никакого дополнительного base64, обязательной компрессии внутри Body или
разбиения состояния по attributes в v1 нет.

Это сознательный компромисс: универсальные инструменты видят JSON-сообщение,
а наш UI понимает его формат. Поиск списка не должен требовать чтения всех
больших Body: необходимые небольшие поля вынесены в OTEL attributes.

## 4. OTEL-представление и индексные поля

### 4.1. Стандартные поля

| Поле | Правило encoder v1 |
|---|---|
| Timestamp | Время начала захвата; совпадает с envelope timestamp. |
| ObservedTimestamp | Время наблюдения SDK, не время получения сервером. |
| SeverityNumber/Text | Для auto capture — 17/ERROR; ручной вызов может переопределить severity. |
| EventName | `exception`, если используемый API его поддерживает. Это не единственный маркер нашего формата. |
| TraceId / SpanId / TraceFlags | Только доступный валидный контекст; без него отсутствуют. |
| Body | JSON-строка с envelope v1. |
| InstrumentationScope | Рабочее имя `app-debug.browser`, версия SDK. |
| Resource | Предоставляется конфигурацией OpenTelemetry пользователя. |

Стандартные exception attributes сохраняются: `exception.type`,
`exception.message`, `exception.stacktrace`, если соответствующее значение
доступно. Это обеспечивает базовую читаемость и без нашего UI. Эти поля и
связь со span соответствуют OTEL exception conventions. [S6]

Resource может содержать `service.name`, `service.version`,
`deployment.environment.name`. SDK не заменяет Resource существующего provider.
Новые runtime/event IDs не добавляются в Resource: в стандартной конфигурации
VictoriaLogs использует ресурсные поля для log streams. [S3]

### 4.2. Собственные поля

| OTEL attribute | Тип при записи | Обязательность / назначение |
|---|---|---|
| `app.debug.schema.version` | integer | Всегда `1`; версия упаковки, не состояния приложения. |
| `app.debug.kind` | string | Всегда `exception` в этой версии. |
| `app.debug.event.id` | string | Идентификатор захвата UUID v4. |
| `app.debug.runtime.id` | string | UUID v4, одна жизнь экземпляра SDK. |
| `app.debug.event.sequence` | integer | Локальный порядковый номер в этом runtime. |
| `app.debug.exception.mechanism` | string | `manual`, `window.error`, `unhandledrejection`. |
| `app.debug.exception.handled` | boolean | Только если известно/задано; auto capture записывает `false`. |
| `app.debug.group.key` | string | Необязательный явно заданный пользователем ключ группы. |

Это поля нашего протокола, не стандартные OTEL semantic conventions. Стандартные
имена не заменяются собственными аналогами. Пользовательские атрибуты не могут
перезаписать зарезервированные поля, а также служебные поля backend-проекции.

Полная exception также находится внутри envelope, чтобы сам Body оставался
диагностически полезным. Encoder обязан записать одинаковые исходные значения
в Body и attributes. При расхождении на чтении сервер показывает предупреждение
`index_payload_mismatch`; не исправляет различие молча и не строит автоматическую
корреляцию по конфликтующим идентификаторам. Полный стек из валидного Body можно
показать рядом с предупреждением о различии с сохранённым index field.

## 5. Envelope v1

Точные типы находятся в `protocol.ts`, машиночитаемая проверка — в JSON Schema.
Полный пример находится в `fixtures/exception-envelope.json`.

Краткая форма:

```ts
interface DebugEnvelopeV1 {
  schema: 'app-debug';
  schemaVersion: 1;
  kind: 'exception';
  eventId: string;
  timestampUnixNano: string;
  monotonicMs: number;
  runtime: { id: string; sequence: number };
  exception: {
    type?: string;
    message?: string;
    stacktrace?: string;
    mechanism: 'manual' | 'window.error' | 'unhandledrejection';
    handled?: boolean;
    location?: { url?: string; line?: number; column?: number };
  };
  trace?: TraceRef;
  state: {
    sources: SourceSnapshot[];
    inline?: CapturedValue;
  };
  history: {
    enabled: boolean;
    sinceUnixNano: string;
    evictedCount: number;
    items: HistoryEntry[];
  };
  groupKey?: string;
  extensions?: Record<string, JsonValue>;
}
```

`extensions` — данные пользователя. Ядро сохраняет их и умеет показать как JSON;
не исполняет их, не загружает код и не приписывает им заранее определённую
доменную семантику. Расширения не могут менять смысл зарезервированных полей.

### Идентичность и время

Все генерируемые SDK IDs — случайные UUID v4. Runtime ID не сохраняется в
cookies/localStorage и не объединяет вкладки, перезагрузки или устройства.
Каждая новая регистрация источника получает новый registrationId, даже если
её имя совпало с удалённой регистрацией.

Sequence — возрастающее безопасное целое JS в пределах runtime. Оно общее для
создаваемых SDK history entries и occurrences; пропуски допустимы. Оно не
обозначает версию доменного состояния. При исчерпании безопасного диапазона
создаётся новая runtime identity, а не повторяются прежние пары `(runtime,sequence)`.

В wire JSON и API абсолютные времена передаются десятичными строками UNIX
nanoseconds. В browser v1 допустима миллисекундная точность:
`BigInt(Date.now()) * 1_000_000n`. Нули в младших разрядах не означают, что браузер
измерил наносекунды. Для интервалов в одном runtime используется `monotonicMs`
из монотонных часов. Для порядка важнее sequence, а не сортировка по wall clock.

## 6. Интерфейс состояния и SDK

Следующий API — проектируемый, не уже опубликованный npm API.

```ts
const client = createClient({
  loggerProvider: existingLoggerProvider,
  captureUnhandled: true,
  history: { enabled: true, maxEntries: 100, maxAgeMs: 30_000 },
  onDiagnostic: diagnostic => console.warn(diagnostic),
});

const unregister = client.registerState('editor', {
  read: () => editor,
  serialize: value => ({
    documentId: value.documentId,
    selection: value.selection,
    pending: value.pending.map(item => item.id),
  }),
});

// Для уже готового JsonValue serialize можно опустить.
const removeConnection = client.registerState('connection', {
  read: () => ({ online: connection.online }),
});

client.addBreadcrumb('command.started', { name: 'applyPatch' });
client.recordState('editor');

const result = client.captureException(error, {
  state: { command: 'applyPatch', patchId: 'p-7' },
  // context: knownOtelContext — необязательный явно сохранённый Context.
});

unregister();
removeConnection();
```

### 6.1. Поведение регистрации

Регистрация разрешена в любой момент. Функция удаления идемпотентна. Одновременно
активные регистрации с одинаковым именем не заменяют друг друга молча:
регистрация-конфликт — ошибка конфигурации. Уже сохранённые history entries
после unregister сохраняются; для очистки есть `clearHistory()`.

Источники читаются только при `captureException` или явном `recordState(name)`.
Регистрация сама по себе не означает subscription, polling или перехват мутаций.
В v1 `read` и `serialize` синхронные. Promise как результат не поддерживается:
для асинхронных данных пользователь заранее поддерживает синхронно доступный
снимок. Это ограничение времени захвата, не модели состояния.

Чтения разных источников последовательны. Мы не обещаем атомарный снимок всего
приложения; snapshot содержит собственное время чтения. Для согласованного
снимка нескольких структур пользователь объединяет их в один source.

### 6.2. Материализация

Результат serialize — JsonValue: null, boolean, finite number, string, плотный
массив или простой JSON-объект. Поддерживаются пустые строки, пустые коллекции,
ключи с точками и вложенные структуры. Значения превращаются в независимую
копию сразу, пока выполняется вызов, а не при позднем export.

Циклы, undefined, functions, symbols, bigint, NaN/Infinity, Promise и произвольные
экземпляры классов без пользовательской сериализации не преобразуются молча.
Пользователь сам задаёт кодирование Date, Map, Set, bigint и специальных типов.
Свойства-аксессоры не следует считать готовыми JSON-данными: serializer должен
материализовать их явно. Если точность integer или знак нуля важны для домена,
пользователь выбирает строковое/тегированное представление.

Размер snapshot не ограничивается политикой продукта. Нет скрытого усечения,
замены «слишком длинных» значений или автоматической отправки в blob storage.
Это не отменяет технических ограничений JS runtime, exporter и принимающей
инфраструктуры. Пользователь управляет содержимым, секретами и допустимым объёмом.

### 6.3. Сбой отдельного источника

```json
{
  "name": "editor",
  "registrationId": "3c1e2150-d90c-4e81-bb25-ea1a00414b08",
  "capturedAtUnixNano": "1789034400000000000",
  "monotonicMs": 42000,
  "status": "error",
  "error": { "stage": "serialize", "code": "serializer_failed" }
}
```

Вместо ошибочного snapshot записывается статус ошибки. Остальные источники и
исходная exception продолжают обрабатываться. Ошибка inline state аналогично
представляется `state.inline.status = error`. Diagnostic callback не должен
рекурсивно запускать capture. Мы изолируем выброшенное исключение, но не можем
прервать бесконечный синхронный пользовательский callback в том же JS потоке.

### 6.4. Контекст конкретного вызова

`state.inline` отделён от `state.sources`. Даже если пользовательские ключи
совпадают с именами источников, значения не перетирают друг друга. Опция
`includeRegisteredState: false` позволяет приложить только inline state.
Опция `includeHistory: false` исключает историю из конкретного capture,
не стирая её в локальном буфере. Для пустого приложения корректны sources=[]
и отсутствие inline state.

### 6.5. Владение OpenTelemetry

Core принимает существующий LoggerProvider и пользуется стандартным OTel
Context. Он не переустанавливает глобальные providers, propagators, sampler
или чужие instrumentations. Он не меняет статус произвольного активного span
и не пишет вторую копию exception как span event по умолчанию.

Отдельный helper внутри того же SDK может создать минимальный logs provider
и HTTP/protobuf exporter для пользователя без готовой настройки. Это не
отдельный транспорт и не новый workspace. Закрытие client не закрывает
переданный пользователем provider. Для чужого provider flush может быть
явно передан callback; Logger API сам по себе не обещает forceFlush. [S14]

`CaptureResult.status = emitted` означает, что emit был вызван без синхронной
ошибки. Это не подтверждение записи в VictoriaLogs и не доказательство, что
пользовательский processor не отфильтровал запись. `flush` тоже не является
end-to-end подтверждением сохранения.

## 7. Локальная история

`addBreadcrumb(name, data?)` создаёт именованную запись произвольного смысла.
`recordState(name)` создаёт снимок зарегистрированного источника. Оба метода
материализуют данные немедленно и возвращают идентификатор записи либо
диагностируемую ошибку вызова.

На момент начала capture фиксируется граница истории. Всё, что добавлено позже,
не попадает задним числом в этот occurrence. Сам capture не добавляется в историю
как полная копия предыдущей ошибки: иначе envelope рекурсивно разрастался бы.

По умолчанию история только локальная и экспортируется внутри error LogRecord.
Нет обязательного потока отдельных transition logs. Накопленные записи могут
быть приложены к нескольким ошибкам; после emit буфер не очищается автоматически.
Пользовательские обычные OTEL logs продолжают существовать независимо.

Предложение по defaults: максимум 100 элементов и возраст до 30 секунд; оба
значения настраиваются, возраст можно отключить. Это ёмкость истории, а не
лимит размера пользовательского snapshot. `evictedCount` считает удаления
по возрасту/ёмкости с последней очистки. `sinceUnixNano` — начало текущего
периода буфера. После `clearHistory()` счётчик и период обновляются.

Уничтожение browser runtime теряет ещё не отправленную историю. В v1 нет
IndexedDB outbox, собственного service worker и обещания доставки после crash.

## 8. Автоматический захват и исходный stacktrace

Подключаются `window.addEventListener('error', ...)` для подходящих ErrorEvent
и `window.addEventListener('unhandledrejection', ...)`. Они не заменяют
существующие обработчики и не вызывают preventDefault. События загрузки
ресурсов не маскируются под JS exception. [S9][S10]

При наличии `error.stack` сохраняется исходная строка. Нет пересборки кадров,
переписывания URL и symbolication. При отсутствии stack — отсутствует поле.
Доступные filename/line/column можно показать отдельно как location, но нельзя
генерировать из них выдуманный stacktrace. Формат stack зависит от runtime. [S11]

Для Error-подобных значений безопасно читаются доступные name/message/stack.
Для строкового или другого примитивного rejection сохраняется его понятное
текстовое представление без придумывания исходных кадров. Произвольный объект
rejection не сериализуется целиком автоматически; пользователь может приложить
его явно через свой безопасный serializer/state.

`handled=false` у auto capture означает «не обработано в момент наблюдения».
Это не обещание, что Promise никогда не получит обработчик позже, и не признак
обязательной остановки приложения. Cross-origin ограничения, закрытие вкладки,
завершение процесса и ошибки самого транспорта ограничивают полноту захвата.

В одном Window допускается один владелец auto handlers от нашего SDK. Повторная
инициализация не должна создавать несколько одинаковых listeners; dispose
снимает свои handlers. Дедупликация по строке stack/message по умолчанию
запрещена: одинаковые ошибки могут быть разными возникновениям. Ручной capture
с последующим rethrow может дать второй auto capture; это должно быть явно
документировано, а не скрыто бесконечным WeakSet по объектам Error.

## 9. Корреляция

### 9.1. Существующий trace

Приоритет: явно переданный OTel Context → текущий активный Context → отсутствие
связи. Валидные trace/span IDs переносятся в штатные OTEL поля и копируются
в envelope trace. Поле origin отмечает active/explicit. Проверяются формат,
длина и отсутствие all-zero IDs. Span ID без trace ID не используется.

Глобальный обработчик может выполняться уже вне контекста исходной операции.
Нельзя привязывать ошибку к «последнему span на странице». Context фиксируется
до вызова пользовательских readers и до асинхронного экспорта.

Идентификатор trace может существовать даже если его spans не были сохранены.
Наш capture не отбрасывает ошибку из-за sampled=false. Однако чужой log processor
или инфраструктурный фильтр по-прежнему могут её отбросить. Отсутствующий trace
означает `not_found`, а не отсутствие самой ошибки.

### 9.2. Степень связи

Сервер различает same_span, same_trace, same_runtime и time_window. Первые
три имеют конкретный ключ корреляции, но даже same_trace не доказывает, что
одна запись является причиной другой. Time window — только соседство по
времени в выбранном source/service, явно обозначенное в UI.

HistoryEntry сохраняет собственный контекст в момент своей записи. Он не
наследует позднее traceId ошибки. Между вкладками и сервисами runtime.id не
пропагируется автоматически; baggage не заполняется нашим состоянием.

### 9.3. Сравнение snapshots

Обычный JSON diff можно предложить для двух успешных snapshots одной пары
(runtime.id, registrationId). Нельзя автоматически считать одноимённые источники
разных регистраций одной сущностью. Diff — различие двух наблюдений, а не
доказательство полного списка мутаций, event sourcing или replay.

## 10. Проекция VictoriaLogs и read adapter

Для прямого ingestion ожидается следующая проекция. Пользовательский Collector
может менять её; поэтому field mapping задаётся серверной конфигурацией. [S5]

| OTEL | VictoriaLogs в проверенной реализации |
|---|---|
| Timestamp | `_time` |
| string Body | `_msg` |
| TraceId / SpanId | `trace_id` / `span_id` |
| SeverityNumber/Text | `severity_number` / `severity_text` |
| EventName | `event_name` |
| Resource и log attributes | Поля с соответствующими именами |
| InstrumentationScope name/version | `scope.name` / `scope.version` |

Query API возвращает JSON lines; адаптер не предполагает, что это массив JSON
или ответ Elasticsearch. Сохранённые индексные числа/boolean декодируются
по известной схеме; JSON Body декодируется отдельно, без восстановления
доменного state из dotted names. [S7]

После flattening нельзя обещать универсальное восстановление различия между
любым произвольным Resource attribute и log attribute. UI показывает достоверно
известные service/release/environment поля и остальные stored fields; не
выдаёт эвристику за точный исходный OTEL Resource.

### Примеры запросов

Сервер передаёт абсолютные start/end и timeout отдельными параметрами запроса.
`end` — исключающая граница. Значения в примерах иллюстративные; запросы
строятся allowlisted query builder, а не склейкой пользовательского LogsQL.

Поиск SDK errors:

```text
app.debug.kind:="exception" service.name:="editor-web"
| fields _time, app.debug.event.id, app.debug.runtime.id,
  app.debug.schema.version, exception.type, exception.message,
  severity_number, trace_id, span_id, service.name,
  service.version, deployment.environment.name
| sort by (_time desc, app.debug.event.id desc) limit 51
```

Чтение конкретной SDK-записи в ограниченном time range:

```text
app.debug.event.id:="d45238c7-4ff0-4e5f-819b-f8d0f4c3c143"
```

Логи соответствующего trace:

```text
trace_id:="4bf92f3577b34da6a3ce929d0e0e4736"
| sort by (_time) limit 201
```

API: POST `/select/logsql/query`, form-urlencoded. У query language есть exact
filters, projection, sorting и агрегаты. Подробности синтаксиса и нагрузки
проверяются на поддерживаемых версиях VM. [S7][S8]

## 11. Server API v1

Это read API для UI; использование POST не означает ingestion.

| Endpoint | Назначение |
|---|---|
| GET `/api/v1/capabilities` | Версия API, доступные функции и безопасная конфигурация UI. |
| POST `/api/v1/occurrences/search` | Структурированный поиск; без больших payload. |
| GET `/api/v1/occurrences/{ref}` | Запись, исходный stack, state, история и предупреждения. |
| POST `/api/v1/occurrences/{ref}/related` | Ограниченный запрос связанных или соседних logs. |
| GET `/api/v1/traces/{traceId}` | Чтение trace по требованию. |
| POST `/api/v1/error-groups/search` | Необязательная группировка за заданный интервал. |

Пример search request:

```json
{
  "range": {
    "startUnixNano": "1789030800000000000",
    "endUnixNano": "1789038000000000000"
  },
  "service": "editor-web",
  "origin": "both",
  "pageSize": 50
}
```

SearchResponse содержит items, фактический range, nextCursor и meta:
queryStatus, servedFrom, fetchedAt, cacheAgeMs и warnings. Search не возвращает
сам snapshot. Для SDK occurrence `contextStatus=not_loaded`, а не обещание,
что envelope уже провалидирован при поиске.

`ref` — versioned base64url locator, не первичный ключ собственной базы и не
auth token. Для SDK содержит eventId и время сохранённой записи; source выбирается
только из конфигурации сервера. Все поля locator валидируются. В нём нет raw
query, произвольного URL, credentials или права сменить tenant.

Для обычного OTEL log без ID locator содержит time/stream и хеш канонического
содержимого строки. Он не делает идентичные logs различимыми: если несколько
записей идентичны, сервер возвращает предупреждение об неоднозначности, а не
придумывает глобально уникальную occurrence identity.

Cursor тоже не требует серверного хранения: он кодирует version, зафиксированный
range, нормализованные filters, config revision и offset. V1 использует простую
пагинацию, не обещая snapshot isolation. Поздно пришедшие данные могут менять
страницы; UI убирает уже увиденные SDK eventIds. Количество просмотренных raw
строк и offset не заменяются количеством элементов после дедупликации.

### Связанные данные и частичные ответы

Базовый occurrence не ждёт VictoriaTraces или VictoriaMetrics. UI запрашивает
trace и дополнительные логи отдельно. Trace adapter вызывает
`/select/jaeger/api/traces/{trace_id}` и нормализует Jaeger-представление;
времена и длительности этого API нельзя без конверсии считать OTLP nanoseconds.
VictoriaTraces документирует Jaeger-совместимые пути. [S12]

Для related request доступны статусы available, partial, not_found, unavailable,
not_configured. До запроса состояние UI — not_loaded. HTTP timeout upstream
не превращается в пустой успешный результат. Если upstream сообщает partial
response, это отражается в meta/warnings. Неизвестная полнота не изображается
как доказанная полнота trace.

Основные ошибки API: 400 — неверный запрос, 401 — нет/неверный токен, 404 —
запись не найдена в проверенном диапазоне, 429 — превышены попытки/бюджет,
502/504 — upstream не отвечает или превышен timeout. Детали с credentials
не попадают в текст ответа.

## 12. Поддержка обычного OpenTelemetry

Default detection: наличие стандартных exception attributes либо известного
exception event name. `severity>=17` само по себе не доказывает exception;
обычные error logs можно включить отдельной явной настройкой.

Без нашего envelope UI показывает найденную ошибку, исходный stack, поля
и достоверную trace-связь. Произвольный пользовательский Body не интерпретируется
как state только потому, что внутри есть ключ `state`.

Старые exception span events можно показать внутри уже открытого trace, если
query backend их возвращает. Первая версия не обещает находить все такие events
глобально без поиска traces; это отдельная возможность, а не скрытое полное
сканирование VictoriaTraces.

Сервер не должен рисовать всю телеметрию пользователя только потому, что умеет
прочитать её. Основной экран — расследование конкретного возникновения.

## 13. Группы без собственной БД

Grouping не является условием захвата или чтения occurrence. Пользователь может
передать groupKey; тогда read-side группирует по service и этому точному ключу.
Не нужно автоматически хешировать или модифицировать его смысл.

При отсутствии ключа допустим простой явно названный режим exact-type-message:
группировка по service, exception.type, exception.message. Это сходство
сохранённых значений, не алгоритм Sentry-quality stack grouping. Возможны
как избыточное разделение динамических сообщений, так и ложное объединение.

Для SDK отдельно возвращаются число уникальных eventIds и число сохранённых
строк. `count_uniq` требует памяти, поэтому запрос ограничен временем и общим
query budget, а не выдаёт частично просмотренные данные за точные. Для обычных
logs без ID возвращается rawRecords; не обещается точное число уникальных
возникновений. [S8]

First/last/count всегда относятся к запрошенному диапазону и доступной retention.
Нет persisted resolved/ignored, назначений, комментариев и состояния regression.

## 14. Надёжность, версии и повреждённые данные

Сервер дедуплицирует повторную доставку SDK-записи по eventId в границах
настроенного data source. При одинаковом ID и разном Body возвращается conflict
warning; новая версия не выбирается молча. Время события при retry не меняется.
OTLP не является обещанием end-to-end exactly-once хранения. [S1]

Совместимость определяют schema marker и schemaVersion, не версия npm пакета.
Неизвестные дополнительные поля известной версии сохраняются и игнорируются
для логики, если не нужны UI. Новый обязательный смысл или несовместимое изменение
получает новую wire version. Неизвестная версия — обычная exception с raw payload
и статусом unsupported_version, а не ошибка всей страницы.

Encoder проверяется строгой схемой. Decoder дополнительно изолирует ошибки
отдельных секций: испорченная state-секция не должна прятать доступный стек.
Невалидный Body не декодируется частично как достоверное состояние. Сохранённые
standard exception fields остаются fallback.

Нет автоматического chunking большого state. Одна запись удобнее для корреляции,
но если её отвергнет транспорт, может потеряться весь context и ошибка вместе.
Это явное следствие выбранной политики, не скрытая гарантия доставки. Диагностика
экспорта делается через SDK/provider diagnostic channel и не запускает бесконечный
capture самого сбоя telemetry.

## 15. Конфигурация, токен и кеш

Конфигурация серверная; следующие имена — проект RFC:

```yaml
auth:
  tokenEnv: APP_DEBUG_API_TOKEN
  failedAttempts:
    perPeerPerMinute: 10
    burst: 5
    maxTrackedPeers: 10000

sources:
  logs:
    baseUrl: http://victorialogs:9428
    headersFromEnv: VM_LOGS_READ_HEADERS_JSON
    fields:
      time: _time
      body: _msg
      traceId: trace_id
      spanId: span_id
      severityNumber: severity_number
  traces:
    baseUrl: http://victoriatraces:10428/select/jaeger
    headersFromEnv: VM_TRACES_READ_HEADERS_JSON
  metrics:
    baseUrl: http://victoriametrics:8428
    headersFromEnv: VM_METRICS_READ_HEADERS_JSON

cache:
  maxBytes: 268435456
  maxEntryBytes: 16777216
  searchTtlMs: 5000
  detailTtlMs: 30000
  traceTtlMs: 5000
  negativeTtlMs: 1000

queries:
  timeoutMs: 5000
  maxPageSize: 200
```

Значения — предложенные defaults, не универсальные требования к инфраструктуре.
`maxEntryBytes` ограничивает только кеш: слишком большой ответ не усекать, а
не класть в кеш. Backend credentials и один API token не включаются в UI bundle,
не кладутся в URL и не передаются в SDK приложения пользователя.

UI вводит token и посылает его в Authorization Bearer; по умолчанию держит его
в памяти вкладки, без отдельной системы сессий. Внешний HTTPS может завершаться
на существующем reverse proxy. Статическая UI оболочка может быть доступна без
токена; все data API, включая cache hits, требуют проверку.

Неуспешные попытки ограничиваются по peer, не по значению перебираемого токена.
Сравнение секрета не должно иметь content-dependent раннего выхода. Кеш
счётчиков ограничен и сбрасывается при рестарте. Forwarded IP принимается только
от явно доверенного proxy. Это простая локальная защита; не заявляется
распределённая защита от перебора на всех репликах без общего limiter.

Ключ кеша включает source/config revision, endpoint, нормализованный запрос,
absolute range и mapping revision. Auth проверяется до выдачи. Нельзя кешировать
401/403 как данные, а transient upstream failure не подменяется пустым результатом.
Для недавно появившегося trace TTL короткий; отрицательный кеш особенно короткий.
Данные отображают время чтения и происхождение из кеша.

Никаких организаций, ролей и пользовательской базы. Параметры источника/tenant
выбираются сервером из конфигурации, не произвольным запросом браузера.

## 16. UI и workspace

UI маршруты: поиск ошибок, конкретное возникновение, связанный trace. Группы
могут быть альтернативным представлением поиска. Сначала ошибка и stacktrace;
state/history рядом, дополнительные logs и trace по запросу. Список не загружает
каждый Body. Огромный JSON не раскрывается полностью автоматически.

Все строки отображаются как текст. Payload не является HTML, URL не открываются
автоматически, сырой контент не исполняется. SDK state — данные, не UI-описание.
Точные trace-ссылки и временные соседства визуально различаются. Пустые панели
не показываются как обязательные части экрана.

```
package.json              # workspaces: packages/ui, packages/sdk
packages/
  ui/
  sdk/
server/                   # вне Yarn workspace; язык этим RFC не задан
docs/                     # SPEC/schema/fixtures; не третий package
```

UI и SDK остаются единственными workspace packages. Общие типы могут находиться
в SDK как type-only subpath либо генерироваться из схемы, но не требуют runtime
зависимости UI от browser instrumentation. Выбор такого размещения не меняет wire
контракт. Примеры библиотек состояния и packages/integrations пока отсутствуют.

## 17. Критерии приёмки первой реализации

| Область | Проверка |
|---|---|
| Динамическая регистрация | Добавление/удаление после init; конфликт имени; повторное удаление. |
| Идентичность | Новый registrationId после unregister/register того же имени. |
| Снимки | После recordState исходный объект меняется, записанный snapshot — нет. |
| Типы JSON | Сохраняются null, false, 0, пустая строка, пустые объекты/массивы, dotted keys. |
| Ошибки serializer | Один source не мешает остальным и исходной exception. |
| История | Cut на начало capture, age/capacity eviction, ясный evictedCount, clear. |
| Auto capture | ErrorEvent и rejection; без stack; два init не создают дубль listener. |
| Контекст | Явный/активный/отсутствующий; auto handler не использует last span. |
| Транспорт | Реальный browser exporter → поддерживаемый pipeline → VictoriaLogs. |
| Round trip | _msg декодируется в исходный envelope, зеркальные index fields совпадают. |
| Дедуп | Retry одного eventId; отдельные ошибки с одинаковым stack не склеиваются. |
| API | NDJSON parsing, границы времени, escaping, pagination и bad locator. |
| Graceful degradation | Нет trace, upstream timeout, partial response, неизвестная версия Body. |
| Vanilla OTEL | Ошибка без SDK работает без state; span events видны в открытом trace. |
| Stateless | После рестарта работают поиск и ссылки, кроме нормально изменившихся данных VM. |
| Auth/cache | Cache hit требует token; invalid attempts ограничены; большой ответ не усекается. |

Минимальный сквозной сценарий: зарегистрировать source → записать breadcrumb и
snapshot → вызвать captureException → получить одну строку из VictoriaLogs →
открыть её после рестарта сервера → увидеть неизменённый stack, inline state,
историю и снимки → открыть существующий trace либо явно увидеть, что он не найден.

Проверки JSON Schema и типов в приложенном пакете выполнены отдельно. Browser SDK,
сервер и round-trip с реальным VM-стеком этим RFC не реализованы и не протестированы.

## 18. Источники технических ограничений

Все перечисленные источники — документация стандартов, производителей или
исходный код соответствующего проекта. Проверены 10 сентября 2026 года.
Проверка текущей ветки репозитория не означает совместимость со всеми версиями
установленного у пользователя VM. Версии для интеграционного CI нужно фиксировать
в реализации и проверять golden round-trip fixture.

- [S1] OTLP Specification: `https://opentelemetry.io/docs/specs/otlp/`
- [S2] VictoriaLogs HTTP OTLP handler: `https://raw.githubusercontent.com/VictoriaMetrics/VictoriaLogs/master/app/vlinsert/opentelemetry/opentelemetry.go`
- [S3] VictoriaLogs OpenTelemetry ingestion: `https://docs.victoriametrics.com/victorialogs/data-ingestion/opentelemetry/`
- [S4] OpenTelemetry Logs Data Model: `https://opentelemetry.io/docs/specs/otel/logs/data-model/`
- [S5] VictoriaLogs receiver and golden tests: `https://raw.githubusercontent.com/VictoriaMetrics/VictoriaLogs/master/app/vlinsert/opentelemetry/pb.go` и `https://raw.githubusercontent.com/VictoriaMetrics/VictoriaLogs/master/app/vlinsert/opentelemetry/opentelemetry_test.go`
- [S6] Exception semantic conventions for logs: `https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/`
- [S7] VictoriaLogs query API: `https://docs.victoriametrics.com/victorialogs/querying/`
- [S8] LogsQL: `https://docs.victoriametrics.com/victorialogs/logsql/`
- [S9] Browser error event: `https://developer.mozilla.org/en-US/docs/Web/API/Window/error_event`
- [S10] Browser unhandledrejection: `https://developer.mozilla.org/en-US/docs/Web/API/Window/unhandledrejection_event`
- [S11] Error.stack: `https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/stack`
- [S12] VictoriaTraces query API: `https://docs.victoriametrics.com/victoriatraces/querying/`
- [S13] OpenTelemetry browser exporters, CORS/CSP: `https://opentelemetry.io/docs/languages/js/exporters/`
- [S14] OpenTelemetry Logs API: `https://opentelemetry.io/docs/specs/otel/logs/api/`
