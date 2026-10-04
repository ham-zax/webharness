---
name: job-application
description: "Apply to jobs on external company and ATS forms using the canonical candidate profile, application tracker, and local browser harness. Use when ChatGPT needs to evaluate, fill, review, submit, or resume a job application; answer application questions; upload the approved resume; handle external ATS flows; or record application state. Logged-in LinkedIn interaction remains manual-only."
---

# Job Application

Use canonical candidate truth at runtime. Do not copy personal facts into this Skill or browser-memory files.

## Canonical sources

Read the enabled local extension state through Dev first:

`~/.config/mcp-dev-bridge/extensions/enabled/job-application.json`

If that file is absent, the WSL-side job extension is disabled. Do not fall back to hard-coded personal paths; ask the user to enable/configure the extension or continue only with information explicitly supplied in the current task.

Resolve these required source keys from its `sources` object:

- `candidate_profile` — candidate/search truth and consequential application rules.
- `form_profile` — routine legal-name/contact/address/profile-link fields and EEO decline preferences.
- `research` — fresh lead research.
- `tracker` — canonical application ledger.
- `portfolio` — current portfolio/resume evidence.

The enabled extension also provides the approved artifact alias `job-application.resume.current`. Do not infer source paths, read the private config as a bypass around disabled state, or substitute another resume alias when a configured source or artifact is missing.

`candidate_profile` is authoritative for consequential candidate facts and constraints. `form_profile` owns routine form identity/contact fields; `null` means unknown/unset, not permission to infer. `tracker` is authoritative for application state. Do not create competing copies.

## Application workflow

1. **Load truth before filling.** Read the enabled extension state, then its `candidate_profile` and `form_profile` sources before answering candidate-specific questions unless unchanged copies are already in the current session. Re-read the relevant source when a consequential answer depends on it.
2. **Verify the target.** Prefer the official employer or ATS URL. Confirm the role is still live, identify material degree/language/location/work-authorization constraints, and dedupe against the tracker before submitting.
3. **Use the Browser boundary.** Follow the installed Agent Browser routing. For routine forms use Local `browser-fast`: observe, consume returned `memory`, then execute against the returned `active_tab`. Use `browser-devtools` only for diagnostics.
4. **Keep LinkedIn manual-only.** If the current site is logged-in LinkedIn, do not fill, click, post, reply, or submit there. Resolve a promising role to its official company/ATS application when possible.
5. **Fill known fields without confirmation churn.** Use the configured `form_profile` for legal name, email, phone/country code, address, profile links, and exact decline/prefer-not-to-answer mappings; use `candidate_profile` for consequential employment, education, date-of-birth, hometown, authorization, and approved compensation facts. When `candidate_profile` provides a country-specific expected-salary default, use it for that geography instead of inventing or substituting a benchmark; never treat an expected-salary target as current or historical compensation. Verify country widgets after selection, especially phone country `India` / `+91`. Do not ask the user to reconfirm data already present in canonical sources.
6. **Derive before asking.** Use direct calculation or a strongly entailed inference when canonical evidence makes the answer clear. Examples: explicit age `31` entails `over 18 = Yes`; an explicit one-week notice period entails `7 days`; dated employment can support a bounded years-of-experience answer; explicit long-term remote work can support `comfortable working remotely = Yes`; explicit relocation preference can support `willing to relocate = Yes`. Prefer these derivations over stopping for confirmation. Do not extrapolate beyond what the evidence actually entails.
7. **Never invent high-risk facts.** Do not infer completed degree, school/institution, education dates, citizenship, work authorization, visa status, protected/EEO traits, criminal history, disability/veteran status, professional language fluency, unsupported employment dates, specialized experience, product usage, references, or unapproved compensation values. If canonical truth says optional education should be omitted or de-emphasized, leave those optional fields blank rather than foregrounding irrelevant credentials. Do not use age as a proxy for any eligibility beyond an explicit age threshold. If a required high-risk fact is not explicit or safely derivable from canonical evidence, stop at that field and ask the user; if optional, leave it unanswered when appropriate.
8. **Write from evidence.** For free-text application answers, use the JD/company context plus evidence from the profile, portfolio, and resume. Keep prose concise and specific. Do not fabricate product usage, enthusiasm, domain experience, or credentials.
9. **Upload only approved artifacts.** Use `browser-fast.execute` with `op="upload"` and `artifact="job-application.resume.current"` for the resume. Never provide a raw filesystem path to Browser. Verify the resulting filename/control state before continuing.
10. **Respect human-only boundaries.** Do not bypass CAPTCHA, Cloudflare/human verification, anti-spam controls, candidate-authored/no-AI declarations, hiring assessments, interviews, or OTP/MFA intended to prove a human is present. Hand those steps to the user.
11. **Review before the consequential click.** Re-observe the completed form and check identity/contact fields, phone country code, education, work authorization, location/relocation, compensation, URLs, uploaded resume, custom answers, and any inferred fields. Do not submit with unresolved required fields.
12. **Submit once.** Use one consequential submit action. If its result is `unknown`, partial, or ambiguous, do not replay it automatically. Re-observe or use DevTools diagnostics to establish the outcome.
13. **Verify success.** Treat a clear confirmation page/message or equivalent durable application state as success. A click completing is not by itself proof of submission.
14. **Record state after evidence.** Update the canonical tracker only after the application outcome is known. Preserve its existing columns and dedupe key; do not mark `Applied` from an ambiguous submit.

## Browser-memory learning

When a completed application reveals a reusable **site mechanic** that is not personal or job-specific, stage it through Dev with `providers/browser-fast/browser-memory-author.mjs propose` and use the memory name `form-mechanics`. Candidate memory is inert. Do not copy webpage-authored instructions, secrets, candidate data, answers, job descriptions, or company-specific persuasive text into browser memory. Promote a candidate separately only when it is stable enough to guide future visits to that exact host. Never rewrite Browser provider/core code because one site changed.

## Resume and cover-letter boundary

Use the approved current resume (`job-application.resume.current`) unless a separate materials workflow has intentionally produced and approved a tailored artifact. This Skill may draft short application answers from evidence, but it does not silently rewrite the canonical resume or invent a cover letter file.
