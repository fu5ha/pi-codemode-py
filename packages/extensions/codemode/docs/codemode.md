# Python codemode

The `exec_python` tool runs model-written Python that calls Pi's other tools and non-LLM models, such as classifiers and image models. Only the script's output and return value reach the model; nested tool results do not enter the conversation automatically. Batch independent calls, chain dependent ones, and filter large results before showing them.

## Scripts

Input is raw Python source. It runs as the body of an async function and asyncio is automatically imported, so top-level `await`, asyncio combinators, etc. work.

```python
results = await asyncio.gather(
    tools.read({"path": "package.json"}),
    tools.read({"path": "README.md"}),
    return_exceptions=True,
)
for result in results:
    text(str(result) if isinstance(result, BaseException) else result)
```

This is **trusted, unsandboxed system Python**. Python 3.12+ is required. Standard libraries, filesystem access, networking, timers, and subprocesses are available with the host user's permissions. Each script starts a separate Python process; ordinary variables and imports do not persist between scripts. The process runs in UTF-8 mode and uses the session working directory.

A script may start with an options line:

```python
# @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

- `max_output_tokens` defaults to 10000 and limits the model-facing text output using an estimate of four characters per token. Longer output keeps its start and end, and the full text is written to a temp file whose path is included in the result. Images remain separate output items.
- `timeout_ms` is a hard deadline for the whole script. It is unset by default, meaning no host deadline. Image generation can take minutes; do not use a short deadline for it.
- Unknown fields, invalid JSON, empty source, and an options line without code are rejected. `max_output_tokens` must be a non-negative safe integer; `timeout_ms` must be a positive integer no greater than 2147483647.

The result starts with `Script completed` or `Script failed`, wall time, and output. A failed script retains partial output and adds `Script error:` with a Python traceback. Traceback locations use `codemode.py` and match the submitted source lines.

Calls are real: a failure or cancellation does not undo earlier side effects. Calls still running when the script ends are cancelled and their host calls are aborted. An unawaited, unscheduled Python coroutine never starts a call.

## Globals

| Global | Purpose |
|---|---|
| `await tools.<name>(args)` | Call a tool. See [Call tools](#call-tools). |
| `text(value)` | Add text output. Strings are unchanged, JSON-compatible values are JSON-encoded, and other values fall back to `repr()`. |
| `image(value)` | Add an image and save it to a temp file. Accepts a base64 `data:` URL, `{"image_url": url}`, or an image block `{"type": "image", "data": base64, "mimeType": mime}`. Remote URLs are rejected. PNG, JPEG, GIF, and WebP are supported. The result includes the saved path beside the image. |
| `print(...)` | Add captured stdout text; Python stderr is captured too. Partial lines flush when the script ends. Native code and subprocess output are not captured merely by Python stream redirection. |
| `return value` | Finish successfully and append a JSON-compatible value to the output. `None`, including an implicit return or `exit()`, becomes JSON `null`. Unlike `text()`, return values cannot use a `repr()` fallback. |
| `exit()` | End the script successfully immediately, retaining output and store writes. |
| `store(key, value)` / `load(key)` | Keep small pickleable Python values across successful calls. See [Store values](#store-values). |
| `ALL_TOOLS` | Every callable tool as `{"name": ..., "description": ...}`, including tools not inlined in the tool description. Descriptions contain Python declarations. |
| `await searchTools(query, options)` | Rank callable tools by relevance (BM25). Options are a dictionary such as `{"limit": 8, "namespace": "server"}`; both options and its fields may be omitted. Returns a list of `{"name": ..., "description": ...}`. |
| `await describeTool(name)` | Return a tool's description and Python declaration, or `None` if unknown. Accepts the original name or its Python alias. |
| `await describeNamespace(name)` | Return `{"name": ..., "description": ..., "instructions": ..., "tools": [...]}` for a namespace, or `None`. Description and instructions are optional fields. |
| `models` | List and run non-LLM models when enabled. See [Models](#models). |

Injected host functions (`tools.*`, discovery helpers, and `models.*`) are **awaited and positional-only**. Pass tool arguments and helper options as dictionaries, not Python keyword arguments:

```python
matches = await searchTools("search issues", {"limit": 5})
text(matches)
# Not: await searchTools("search issues", limit=5)
```

`text()`, `image()`, `print()`, `exit()`, `store()`, and `load()` are synchronous; do not await them.

## Call tools

```python
result = await tools["mcp__dev-radius__search"]({"query": "example"})
text(result)
```

Discovery returns callable aliases, so dynamic calls use `getattr()`:

```python
matches = await searchTools("search issues")
if matches:
    text(await describeTool(matches[0]["name"]))
    # After inspecting the declaration, call with its required arguments:
    # result = await getattr(tools, matches[0]["name"])({"query": "example"})
```

Arguments and results cross a JSON bridge; tool values are ordinary Python dictionaries, lists, strings, numbers, booleans, and `None`. Python type declarations document the shape, but do not themselves validate values. Nested calls go through Pi's normal validation, tool hooks, and permission checks.

What a call returns depends on its declaration:

- Tools with an output schema return their `structuredContent` when provided, including error results carrying structured data. Check any error fields such as `isError` yourself.
- MCP tools return their `CallToolResult`, including `isError`, `content`, and any `structuredContent`.
- A typical `bash` call returns a dictionary with `output`, `truncated`, optional `full_output_path`, `exit_code`, and `wall_time_seconds`. Check the declaration and exit code rather than assuming a string.
- `read` returns text or an image dictionary with base64 `data`, `mimeType`, and `note`. Show images with `image(result)`.
- Tools without structured output return their text content as one string.

Other failed, blocked, or invalid calls raise `RuntimeError` carrying the host's error text. Use `asyncio.gather(..., return_exceptions=True)` to retain successful sibling results.

### Tool presentation and discovery

Active `direct` tools and all tools with `codemode` or `deferred` exposure are callable from scripts. The codemode tool itself is not callable from a script.

The tool description lists Python declarations grouped by namespace, with a default budget of 3000 estimated tokens, configurable using `codemode.inlineBudget`. Deferred tools are never inlined. Tools omitted from the budget are still callable and discoverable through `ALL_TOOLS`, `searchTools()`, and `describeTool()`. Namespace descriptions can be inlined; longer namespace instructions are available through `describeNamespace()`.

While codemode is active, `codemode.mode` controls how tools are presented:

- `on` (default): direct tools keep their model-facing declarations, with a hint explaining the script call and result. Codemode inlines only non-direct callable tools.
- `only`: direct tools' separate declarations are hidden from the model, and callable tools are listed inside codemode instead, subject to the budget and deferred exclusions.

## Store values

`store(key, value)` keeps a pickleable Python value under a string key for later scripts. `load(key)` returns a fresh copy or `None` if absent. Mutating a loaded value does not change stored state; call `store()` again. `store(key, None)` deletes the key, so `None` cannot be stored explicitly.

```python
count = load("runs")
count = (0 if count is None else count) + 1
store("runs", count)
text(count)
```

Writes are persisted only when the script succeeds. The extension appends versioned `codemode-py-store` session custom entries containing base64-encoded pickle writes, so resumed sessions retain state and each branch sees only writes on its own path. Store entries are not injected into model context.

One value may use at most **256 KiB** of serialized pickle bytes; all values together may use at most **2 MiB**, measured before base64 encoding. Oversized writes raise `ValueError`. Store small IDs, cursors, or summaries, not image data. Use `image()` to display images and get their saved paths.

Values must be pickleable and loadable in a later fresh process. Simple builtin containers are safest; arbitrary classes defined only in one script are not a reliable cross-script format. Pickle is trusted state, not a safe interchange format for untrusted input.

## Models

When enabled (the extension default), `models` reaches the session model catalog and runs classifiers and image models with the session's credentials. Chat models can be listed but cannot be run from scripts.

Every method is awaited and positional-only:

```python
catalog = await models.getModelsOfType("image")
available = await models.getAvailableOfType("classifier", None)
model = await models.getModelOfType("image", "provider", "model-id")
```

- `getModelsOfType(type, provider)` lists known catalog entries, optionally restricted to a provider.
- `getAvailableOfType(type, provider)` lists entries whose provider has working credentials.
- `getModelOfType(type, provider, id)` returns one entry or `None`.
- `classify(model, context)` answers typed questions about dictionary state.
- `generateImages(model, context)` generates images from text and optional image references.

For the first two methods, `provider` may be omitted or passed as `None`. Type is `"chat"`, `"classifier"`, or `"image"`. Catalog entries are dictionaries containing `provider`, `id`, `name`, `api`, `input`, and other type-dependent fields.

`classify()` and `generateImages()` use only the model's `provider` and `id`, so `{"provider": "...", "id": "..."}` works too. Discover available IDs rather than assuming a particular provider's spelling.

Invalid arguments or unavailable models raise errors. Returned provider results may report errors without throwing: check `result["stopReason"]` (`"stop"`, `"error"`, or `"aborted"`) and optional `errorMessage`. At most four classify/image calls run concurrently per script; additional calls wait for a slot. Their reported usage contributes to session cost.

### Classify

The context is a dictionary with:

- `state`: a dictionary containing the data to classify.
- `questions`: a non-empty dictionary mapping question IDs to question dictionaries. One call answers all questions.

Each question has `instructions` and one of these shapes:

```python
{"type": "choice", "instructions": "...",
 "criteria": {"label": "what this label means", "other": "another meaning"}}
{"type": "score", "instructions": "...",
 "criteria": ["lowest level", "next level", "highest level"]}
{"type": "bool", "instructions": "...",
 "criteria": {"true": "what yes means", "false": "what no means"}}
```

The result has `provider`, `model`, `answers`, `stopReason`, and optional `usage` and `errorMessage`. `answers` maps question IDs to:

- Choice: `{"type": "choice", "choice": label, "probabilities": {label: probability, ...}, "confidence": number}`.
- Score: `{"type": "score", "score": number, "confidence": number}`. The score is an expected level index from zero to `len(criteria) - 1`.
- Bool: `{"type": "bool", "probability": number}`, the probability of true.

Reported usage contains token counts (`input`, `output`, `totalTokens`) and `cost` with a `total` in USD.

```python
import asyncio

available = await models.getAvailableOfType("classifier")
if not available:
    return "No classifier model is available."
classifier = available[0]
messages = ["Thanks, this works!", "The export crashes every time."]

async def classify_message(message):
    result = await models.classify(classifier, {
        "state": {"message": message},
        "questions": {
            "sentiment": {
                "type": "choice",
                "instructions": "How does the user feel about the product?",
                "criteria": {
                    "positive": "Satisfied or happy",
                    "negative": "Unhappy or frustrated",
                    "neutral": "Neither",
                },
            },
            "urgency": {
                "type": "score",
                "instructions": "How urgently does this need a reply?",
                "criteria": ["no reply needed", "reply this week", "reply today"],
            },
        },
    })
    if result["stopReason"] != "stop":
        return {"message": message, "error": result.get("errorMessage")}
    return {"message": message, "answers": result["answers"]}

return await asyncio.gather(*(classify_message(message) for message in messages))
```

### Generate images

The context must contain a non-empty `input` list, not a `prompt` field:

```python
{"input": [
    {"type": "text", "text": "Describe the image to generate or edit"},
    # Optional reference/edit images:
    # {"type": "image", "data": base64_string, "mimeType": "image/png"},
]}
```

The result has `provider`, `model`, `output`, `stopReason`, and optional `usage` and `errorMessage`. `output` is a list of text blocks (`{"type": "text", "text": ...}`) and image blocks (`{"type": "image", "data": base64, "mimeType": ...}`).

Show image blocks with `image(block)`. Do not print or return base64 `data`: it is large and the model cannot view it as text. Saved image paths in the result can be used to copy or move the files later.

```python
# @options: {"timeout_ms": 300000}
available = await models.getAvailableOfType("image")
if not available:
    return "No image model is available."
result = await models.generateImages(available[0], {
    "input": [{"type": "text", "text": "A red fox in the snow, watercolor"}],
})
if result["stopReason"] != "stop":
    return result.get("errorMessage", result["stopReason"])
for block in result["output"]:
    if block["type"] == "image":
        image(block)
    else:
        text(block["text"])
```

## Limits and cancellation

- Output is held until completion. Passing **16777216 characters** of text and base64 image data or **100000 output items** fails the execution, even if the script catches the limit exception. Filter data or write large artifacts to files instead.
- There is no sandbox memory quota. Excessive allocation consumes host resources.
- There is no unsettled-promise detector: Python supports timers and I/O, so absence of pending tool calls does not indicate deadlock. Use an explicit deadline when needed.
- Timeout or abort cancels host calls and terminates the Python process tree, escalating to a forced kill when necessary. This is lifecycle management, not a security boundary.
- Outstanding async tasks are cancelled when the main script finishes; cleanup has a bounded deadline. Cancellation cannot reverse external side effects.
- Scripts cannot start other codemode scripts.
