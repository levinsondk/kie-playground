# Kie Playground

A local, single-user image playground built from scratch with React, TypeScript and Vite. Kie is the only generation backend.

## Run

```sh
npm ci
npm run catalog:refresh
npm run dev
```

Open `http://127.0.0.1:5173`. Put your Kie key in `.env` as `KIE_API_KEY=...`; the server creates that file, empty, if it is missing. You can also connect a key in the UI. Connecting checks your balance and does not create an image. Generating uses your Kie credits. A successful HTTP request may still contain a Kie application error; both are checked.

The server reads the key from `.env` whenever it needs it, so editing the file takes effect without a restart. The file is created readable only by you and is excluded from git. A key connected in the UI overrides it until the server restarts or you switch back in the connection dialog; that key lives only in the server's memory. Neither is ever returned to the browser or saved in local storage. **Never use a `VITE_` environment variable for credentials**: Vite exposes those to the browser bundle.

The app binds to loopback only and rejects foreign Host and Origin headers. In development it also refuses URLs for `.env` files and `data/runtime/`, which Vite's dev server would otherwise return to other localhost pages. To try it on a phone, `npm run start:lan` also listens on your local network and prints a link for each network address. Other devices get in only through that link: it carries an access token, which the device then keeps in a cookie. Anyone with the link can use your key and see your history, so keep it to your own devices. The token is stored in `data/runtime/access-token`; delete that file and restart to sign out every device. It is not a multi-user service and must not be exposed to a public network without adding authentication and an appropriate deployment review. No startup service is installed.

## Models and parameters

`npm run catalog:refresh` imports the English image-model entries and OpenAPI schemas from Kie's official documentation. The UI's refresh button invokes the same importer. The versioned local catalog and source documents preserve the provenance of model IDs, fields, defaults, enums and constraints. These are documentation snapshots, not an account-specific promise that a model is available. Documentation can be stale and upstream behavior can change.

Only parameters defined for the selected model are sent. Required fields, enum values and numeric constraints are validated before calling Kie. Optional fields can be omitted. Explicit boolean `false` is different from leaving a field unset. No model parameters or safety settings are rewritten by the local server. Upstream terms, model behavior and moderation still apply independently.

## Files and jobs

Reference images are uploaded to Kie's documented upload service when you choose an upload. They leave your machine. Uploads are free and create no task, so the server retries them on network errors. The returned reference URL can expire; Kie's upload documentation currently states 24 hours, so a reference kept from an earlier day may need uploading again.

Task metadata, prompts, parameters and provider task IDs are saved under `data/runtime/`, with restrictive file permissions. Images are cached locally when opened or downloaded. This directory is excluded from git. Do not treat provider-hosted output URLs as permanent storage; download results you want to keep. The delete button under the canvas removes the selected image and its cached copy after a second click; deleting a task's last image, or a failed task, removes the task from history. A running task cannot be deleted, and nothing is deleted at Kie.

Retry, above the canvas, runs the shown task again with the same parameters. This creates a new billable task. Its result becomes another take of the same image: the image keeps its place in the history, its thumbnail shows how many takes it has, and the arrows beside Retry switch between them. Delete removes only the take shown.

Parameters are shared between models rather than kept per model. A value such as the prompt, references, aspect ratio, resolution or safety checker carries over to every model with a matching field, even when that model names it differently (`image_size` on one model, `aspect_ratio` on another). Where a model cannot accept the value, it uses its documented default, and the value is kept for the next model. The Request JSON shows exactly what the selected model will receive. Presets save the current settings under a name, and loading one applies them to whichever model is selected. Reset to defaults clears the current settings, so every model starts from its documented defaults.

The selected model, current settings, presets and pinned models are kept by the server in `data/runtime/workspace.json`, so every device that opens the playground shares them; a change made on one shows up on the others within a few seconds. Hide images and whether the history sidebar is expanded stay with each browser. A browser that kept these settings itself, before this version, adds its presets and pins the first time it opens the playground.

Pending tasks are resumed from local history once your API key is connected. Closing the page or losing connectivity does **not** cancel an already-submitted upstream task or its charges. The app deliberately does not automatically retry task-creation POSTs: a timeout can happen after the provider created a billable job.

## Verify / production build

```sh
npm test
npm run build
npm start
```

`npm start` serves the built UI and API on the same loopback address. `PORT` can select a different local port.

Automated tests use explicitly labeled fixtures and never call a paid endpoint. The browser tests (`npx playwright test`) build the current source into a temporary folder and give every test its own server, with an empty temporary data folder and no API key, so they never touch your history, workspace or key, and the app need not be running. A build and fixture-based test pass is not evidence of a successful generation against your account. A real generation requires a connected key and an explicit Generate or Retry action.
