# Projektplan: Ein praktisches Tool mit Star-Potenzial

Stand: 2026-10-26 · Status: Entscheidung offen

---

## 1. Was die Daten sagen

Ich habe per GitHub-API ausgewertet, welche Repos 2026 tatsächlich Stars abräumen
(neu erstellt, sortiert nach Stars). Muster:

| Muster | Beispiele (Stars) | Übertragbar? |
|---|---|---|
| Agent-Harness / Skills-Packs | openclaw 393k, superpowers 305k, anthropics/skills 184k | ❌ völlig übersättigt |
| **Ein Problem, ein Befehl, null Config** | witr 22,8k („warum läuft das?"), dbx 27,8k (DB-Client, 25 MB), Filee 12,8k (263 Formate offline) | ✅ **stärkstes Muster** |
| „Pure Rust"-Reimplementierung von Profigeräten | photocraft 73k, pdfcraft 18k, filmcraft 16k | ⚠️ riesig, aber Monate Arbeit |
| Local-first, offline, kein Login | peach 12k, openGym 16k, watermarks-remover 25k | ✅ gute Story |
| Kosten/Token-Sparer für Agenten | rtk 84k, caveman 115k, OmniRoute 81k | ⚠️ bereits 10+ Klone |

**Kern-Erkenntnis:** Sterne kommen 2026 nicht von „AI-Agent X" (davon gibt es
tausende, niemand schaut hin), sondern von **einem präzise formulierten Problem,
das jeder Dev wöchentlich hat, gelöst durch einen einzigen Befehl mit
Null-Konfiguration** — plus einem Demo-GIF, das man weiterleitet.

---

## 2. Die Lücke, die ich gefunden habe

Wenn ein Dev fragt *„warum sieht dieser Code so aus?"*, gibt es heute nur
`git blame`: eine Liste von Commits, ohne Kontext. Die eigentliche Antwort liegt
in PR-Diskussion, Issue, Reverten und späteren Änderungen — und ist manuell
zusammenzusuchen.

Ich habe die Nische geprüft: **kein dominantes Repo** für Code-Archäologie /
„line biography" (Suche nach `git blame`, `code archaeology`, `why code history`
liefert nur Randtreffer und Awesome-Listen). Gleichzeitig ist `witr` („Why is this
running?") mit 22,8k Stars der Beweis, dass genau diese Frageform funktioniert.

---

## 3. Drei Kandidaten im Vergleich

| | **A. Whyline** — „git why" | **B. Mocksmith** — Spec → lebende Fake-API | **C. Costline** — Agent-Budget-Wächter |
|---|---|---|---|
| **Versprechen** | `why src/auth.ts:42` → die ganze Geschichte dieser Zeile | `mocksmith openapi.yaml` → laufende, *stateful* Fake-API mit realistischen Daten | Lokaler Proxy: was kostet welcher Agent-Lauf, pro Datei/Tool, mit Hard-Limit |
| **Schmerz** | hoch, täglich | mittel-hoch | hoch, aber neu |
| **Reichweite** | jeder Dev, jede Sprache | Frontend/Fullstack-Teams | Agent-Nutzer (2026 groß) |
| **Sättigung** | **niedrig** | mittel (Prism, MSW, json-server) | **hoch** |
| **Demo-Faktor** | ⭐⭐⭐ ein Befehl → schöne Timeline + teilbarer HTML-Report | ⭐⭐ curl-Ausgabe | ⭐ Latenz/Kosten-Dashboard |
| **Aufwand MVP** | 1–2 Tage | 2–4 Tage | 3–5 Tage |
| **Moat** | Zeilen-Biografie, Revert-Archäologie, PR/Issue-Verknüpfung, JSON für Agenten | Statefulness + Failure-Injection + deterministische Seeds | Integrationstiefe je Harness |
| **Star-Prognose** | **hoch** | mittel | mittel |

### Empfehlung: **A. Whyline**

Begründung in einem Satz: bestes Verhältnis von Aufwand zu „sofort verstehbarer
Nutzen", braucht **keine API-Keys, keine Config, kein Backend** — läuft offline
auf jedem Repo, und die Ausgabe ist ein Screenshot, den Leute freiwillig posten.

**Der Trick für 2026:** Das Tool braucht kein LLM, liefert aber `--json` und
einen MCP-Modus. Damit ist es *das* Werkzeug, das Coding-Agenten aufrufen, wenn
sie „warum ist das hier?" beantworten müssen — ohne selbst ein Agent zu sein.
Diese Positionierung („Infrastruktur für Agenten, nützlich ohne Agenten") ist
genau die, die in den Daten gewinnt.

---

## 4. MVP-Scope für Whyline (bewusst klein)

**Muss (Tag 1):**
1. `why <file>:<line>` — Commit, Autor, Datum, Message, Diff-Hunk der Zeile
2. **Zeilen-Biografie**: alle späteren Änderungen dieser Zeile (Survival, Moves via `-M -C`, Reverts)
3. GitHub-Anreicherung *optional*: PR + Issue per `gh`/Token, sauber degradierend ohne Auth
4. **`--html`**: eigenständiger, teilbarer Report (eine Datei, offline öffnbar) ← unser Live-Preview-Asset
5. `--json` für Maschinen

**Soll (Tag 2):** TUI-Ansicht, `why --file <path>` (Datei-Historie), „diese Zeile
hat 3 Refactorings überlebt"-Badges, Farb-/No-Color-Modi, `--since`.

**Später:** MCP-Server-Modus, GitLab/Bitbucket, `why --pr`, Benchmark „Antwortzeit
< 300 ms auf Linux-Kernel-Repo".

**Stack:** Go (Single Binary, `go:embed` für den HTML-Report, ~1 Tag bis lauffähig).
Alternative: Rust für maximalen Street-Cred, kostet aber 1–2 Tage mehr.

**Name:** `whyline` (why + line). Alternativen: `lineage`, `archaeo`, `whodunnit`.
Vor dem Bau: npm/crates/brew-Namen prüfen (Kollisionen).

---

## 5. Star-Playbook (was nach dem Code zählt)

1. **README als Landingpage**: 8-Sekunden-GIF oben, ein Befehl, keine Prosa-Wüste
2. **Ein-Zeilen-Install**: `brew install whyline` / `go install` / `docker run`
3. **Vergleichstabelle**: „warum nicht `git blame`?" — direkt im README
4. **Launch**: Show HN (Di–Do, 15–17 Uhr CET), r/programming, Lobsters,
   `awesome-cli-apps`-PR; Titel: *"Show HN: Whyline – git blame, but it tells you the story"*
5. **Erster Inhalt**: 3 Blog-artige Beispiele auf echten OSS-Repos (z. B. eine
   berühmte Bugfix-Zeile) — Content, der geteilt wird, ohne Werbung
6. **Erfolgsmetrik**: 500 Stars in 14 Tagen = Signal; < 50 = Positionierung falsch, nicht Code

---

## 6. Validierungs-Gate vor dem Bauen (30 Min)

- [ ] Namens-Kollisionen prüfen (`whyline` auf GitHub, crates.io, npm, brew)
- [ ] 2–3 existierende Tools testen, klare Lücke im README belegen können
- [ ] Titel + 3-Satz-Pitch schreiben, an einer fremden Person testen: versteht sie es in 10 Sekunden?

## 7. Offene Entscheidungen

1. Kandidat A, B oder C? (Empfehlung: A)
2. Go (schnell) vs. Rust (Prestige)?
3. Soll ich direkt ein klickbares Mockup des `--html`-Reports bauen, damit du das
   Ergebnis *vor* dem CLI-Code siehst?
