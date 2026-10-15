# Google OAuth verification: demo video script

For the "Demo video: how will the scopes be used?" step of the GCP `pigeonbox-cloud` verification.

## Why no staging setup is needed

Google's warning is about apps that are **already public** (consent screen *In production*). PigeonBox's OAuth app is still in **Testing** mode (`pigeonbox-cloud/workers/api/wrangler.toml`), so only listed test users can grant scopes. Record against production (`usepigeonbox.com/dashboard`) with a test account. The "Google hasn't verified this app" screen will appear. Leave it in the video; Google requires it.

## Before recording

- [ ] Use a **dedicated test Gmail account** listed under *OAuth consent screen → Test users*. Seed it with a few real-looking emails, a newsletter, and one calendar event this week.
- [ ] If that account was connected before, remove PigeonBox at <https://myaccount.google.com/permissions> so the full consent screen shows again.
- [ ] Browser UI and Google language set to **English**. Address bar visible the whole time (no full-screen, no cropping).
- [ ] Have a second account ready to send the test account an email during the recording.
- [ ] Turn off notifications. Record at 1080p. Keep it under ~5 minutes. Upload to YouTube as **Unlisted**.
- [ ] Narrate, or add on-screen captions naming each scope as you show it.

## Shot list

### 1. Intro (≈15 s)
Show usepigeonbox.com. Say: "PigeonBox is a Gmail assistant. PigeonBox Cloud keeps triage, drafts and follow-ups current while Gmail is closed. This video shows the OAuth flow and how each requested scope is used."

### 2. OAuth consent flow (the most important part)
1. Dashboard → **Connected accounts**. Show the feature picker, then check **every** box: Read and sync mail, Create drafts, Organize mail, Read calendar, Add calendar events, Send mail. (All scopes being submitted must appear in the consent flow.)
2. Click **Connect Gmail with Google**.
3. On Google's account chooser, **pause and click into the address bar** so the full URL is readable. Zoom or scroll so `client_id=375986494503-5ubt12vr9a4leh97btdakg5a0bv05qnn.apps.googleusercontent.com` is visible. Reviewers check that it matches the project.
4. Pick the test account. Show the **"Google hasn't verified this app"** screen → *Advanced* → *Go to PigeonBox (unsafe)*.
5. On the consent screen, show the app name **PigeonBox** and slowly scroll through each permission. Check them all, click **Continue**.
6. Back on the dashboard: "Connected" note, and every permission shows **Granted**.

### 3. Each scope in use
Name the scope out loud (or caption it) before each segment.

| Scope | Feature in UI | What to show |
|---|---|---|
| `gmail.readonly` | Read and sync mail | Close Gmail. Send the test account an email from the other account. Show it appearing in **Overview** / Focus Queue with a summary, without Gmail open. |
| `gmail.compose` | Create drafts | **Sync & routines** → Background drafts with "Also put them in Gmail as drafts" on. Show the prepared draft in PigeonBox, then in Gmail's **Drafts** folder. Say "nothing is sent." |
| `gmail.modify` | Organize mail | **Automations** or **Mailing lists**: turn on a rule that labels or archives the newsletter. Show the label/archive in Gmail, then undo it. |
| `gmail.send` | Send mail | Trigger an action that sends (e.g. approve a reply). Show it waiting in **Approvals**, click Approve, then show it in Gmail **Sent**. Say "PigeonBox only sends after explicit approval." |
| `calendar.readonly` | Read calendar | **Briefings**: show a briefing that cites the calendar event this week. |
| `calendar.events` | Add calendar events | Approve a suggested event in **Approvals**, then show it in Google Calendar. |
| `openid email profile` | Sign-in | Already shown in step 2 (account email on the Connections page). |

### 4. Data controls (≈20 s)
**Privacy & data** → "Delete synced mail data". Then **Connected accounts** → disconnect, and show PigeonBox gone from <https://myaccount.google.com/permissions>.

## Before you submit

- Every scope listed on the consent-screen config must be demonstrated. If you can't show one convincingly, remove it from the submission rather than leave it undemonstrated.
- Expect pushback on `gmail.modify` alongside `gmail.readonly` + `gmail.compose` (it's a superset). Be ready to justify it as labeling/archiving only.
- Gmail scopes are restricted, so after the video is approved Google will also require the annual CASA security assessment.
