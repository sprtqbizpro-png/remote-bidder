# King Star

Chrome extension + web app for job bidding: extract job details, autofill applications with OpenAI (remembering your fixed answers), save resumes to Google Drive, and browse applied jobs in the **King Star** viewer.

## Architecture

```
Job bidder/
├── backend/     Express API + JSON store (jobs, fixed answers, Drive upload, OpenAI)
├── extension/   Chrome extension (MV3) — extract, autofill, save
└── web/         King Star React app — applied jobs list & viewers
```

The extension and web app both talk to the same API (`http://localhost:3847` by default).

## Prerequisites

- Node.js 18+
- OpenAI API key
- Google Cloud OAuth client (for Drive resume uploads)
- Chrome / Chromium

## 1. Backend setup

```bash
cd backend
copy .env.example .env   # Windows
# or: cp .env.example .env
```

Edit `.env`:

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Generate answers for application questions |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Drive uploads |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3847/api/auth/google/callback` |
| `FRONTEND_URL` | `http://localhost:5280` |

Google Cloud console:

1. Create an OAuth 2.0 Client ID (Web application).
2. Add authorized redirect URI: `http://localhost:3847/api/auth/google/callback`.
3. Enable the **Google Drive API**.

```bash
npm install
npm run dev
```

API health: [http://localhost:3847/api/health](http://localhost:3847/api/health)

## 2. King Star web app

```bash
cd web
npm install
npm run dev
```

Open [http://localhost:5280](http://localhost:5280).

In **Settings**:

1. Connect Google Drive (required before resume upload from the extension).
2. Optionally paste an OpenAI key (or rely on `.env`).
3. Add fixed answers (years of experience, sponsorship, LinkedIn URL, etc.).

### Web app features

- List of applied jobs: company, role excerpt, resume link
- **View job** → job description as a `.txt`-style viewer (download available)
- **View resume** → opens the Google Drive / Docs link

## 3. Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Click the King Star icon → set API base URL (`http://localhost:3847`) and optional OpenAI key
5. On any job / application page, click the dock button (or open the panel from the popup)

### Extension workflow

1. **Extract** — company name, role, job description (editable in the panel)
2. **Remember fixed answers** — patterns you reuse on every form
3. **Autofill answers** — fixed matches first, then OpenAI for the rest; fields fill automatically
4. **Save resume → Drive** — pick the file you uploaded; stored in Drive folder `King Star Resumes`
5. **Save applied job** — stores company, role, description, and Drive resume link for King Star

## API overview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/jobs` | List applied jobs |
| POST | `/api/jobs` | Save applied job |
| GET | `/api/jobs/:id` | Job detail |
| GET/POST | `/api/answers/fixed` | Fixed answers |
| POST | `/api/answers/generate` | Fixed + OpenAI answers |
| POST | `/api/extract` | Hybrid OpenAI job field extraction |
| POST | `/api/resume/upload` | Multipart resume → Drive |
| GET | `/api/auth/google` | OAuth start URL |

### Job extraction pipeline

1. **JSON-LD `JobPosting`** when present on the page  
2. **ATS-specific CSS** (Greenhouse, Lever, Ashby, Workday, Indeed, LinkedIn)  
3. **Heuristic scrape** of main content + confidence score  
4. **OpenAI fallback** when confidence is low (or click **AI extract**)  

Results are editable in the extension panel before autofill/save.

## Tips

- Keep the API running while using the extension and web app.
- If the panel does not open, reload the tab after loading the extension.
- Autofill works best on standard HTML forms (Greenhouse, Lever, many company sites). Complex Workday/iframe flows may need manual tweaks.
- Job description extraction is heuristic; edit fields in the panel before saving.
