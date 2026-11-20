# Bugs connus et corrections — Hephaistos2-Kit
> Compile automatiquement depuis les rapports de dysfonctionnement (sanitise).

## 01 — nim-worker : templates legataires, prompt non substitue et livrables factices
**Symptome** : 1. Les workers `nim1`/`nim2` (NVIDIA NIM, pont texte-seul) auto-cloturaient des taches `code`/`explore` en `completed` sans produire le moindre fichier :
   - #500 : diff "livre" pretendait modifier un `init_db` en `sqlx` inexistant (`orch.rs` utilise `rusqlite`/`with_db`, aucun CREATE TABLE cote Rust). `git status` : `hphe/` intact.
   - #509 : `fix_report_phase1_1.6.md` et `TRACKER.md` declares ecrits, absents du disque.
   - #520 : nim1 pretendait avoir ecrit `hphe/crates/hphe-orch/Cargo.toml` + `src/main.rs` ; le repertoire n'existait pas.
   - #523 : le "deliverable" `phase3-4-acp-fallback.js` (33,6 KB) etait un dump de chain-of-thought se terminant par "Let's restructure the code…
**Cause** : `nim-worker.mjs` (a) ne lisait pas la tache en DB (contexte reduit au prompt dispatch), (b) cloturait sur simple affirmation du modele — aucune verification de `expected_artifact`, (c) prompt sans garde-fou anti-simulation : le modele simulait des appels MCP/JSON-RPC dans sa sortie texte, (d) `template_to_spawn_plan` ne substituait pas le jeton `{workspace}`, (e) templates legataires non nettoyes lors des migrations du seed.
**Correction** : - `readTask` : lecture directe SQLite (`node:sqlite`) de la description et `expected_artifact` au demarrage du worker.
- System prompt anti-simulation : interdiction explicite de simuler des appels MCP/JSON-RPC ou d'affirmer des ecritures non effectuees.
- `gateArtifact` (`statSync`) : existence + fichier regulier + taille non nulle + `mtime > created_at/dispatched_at` ; toute cloture demandee avec livrable absent/vide/perime force `failed`. Applique sur les deux chemins de cloture.
- Purge des 6 `prompt_templates` legataires ; correction de la substitution `{workspace}` dans `template_to_spawn_plan`.
- `full_prompt=true` confirme pour nim1/nim2 ; abort timeout 300 s sur les appels…

## 02 — vibe (mistral-vibe) : provider mort en course, tache zombie
**Symptome** : La tache #502 (reprise du chantier `orch.rs` apres le rejet de #500) etait dispatchée vers l'agent 8 via le provider `vibe`/`mistral-medium-latest`. La CLI vibe remontait `Vibe budget exhausted` (HTTP 402) : aucun worker effectif, la tache restait `in_progress` fantome pendant que #495/#496 (meme fichier `orch.rs`) tournaient en parallele — risque de collision d'ecriture.
**Cause** : 1. Budget quota du provider vibe epuise (402 Payment Required).
2. Aucun gate au dispatch : le provider etait selectionne sans verification qu'il etait joignable/solvent.
3. Pas de reaper : une tache dont le worker n'a jamais demarre restait `in_progress` indefiniment.
**Correction** : - #502 marquee `failed` par agent-AGY (requalification zombie).
- Scope `orch.rs` repris en direct par agent-Devin (ordre agent-AGY) : #495-499 livres.
- FR-02 : `dispatch_task` refuse desormais un provider `enabled=0`.
- FR-07 : circuit breaker `model_health` — 3 echecs consecutifs (incl. 402) -> `provider_prefs.enabled=0` + `disabled_at` + event ; un provider vibe en 402 repete est automatiquement ecarte de la chaine.
- FR-08 : heartbeat + reaper — un spawn sans tick vivant est reape en `failed`.

## 03 — kilo -> openrouter : dispatch vers provider desactive + agent inconnu
**Symptome** : La tache #503 etait dispatchée vers kilo/openrouter alors que le provider openrouter etait `enabled=0` dans `provider_prefs`. Le dispatch echouait en cascade avec egalement une erreur `User not found` (agent cible non enregistre). La tache restait bloquee.
**Cause** : Avant la Phase 1, `dispatch_task` ne validait ni l'existence du provider dans `provider_prefs`, ni son etat `enabled`, ni l'agent cible. Le dispatch etait optimiste : toute combinaison invalide produisait un echec tardif ou un spawn impossible plutot qu'un refus explicite.
**Correction** : - #503 marquee `failed`.
- FR-01 : refus de tout dispatch avec `model`/`provider` vide ou absent, erreur JSON-RPC explicite, aucun process lance.
- FR-02 : refus d'un provider `enabled=0`, avec position de la chaine dans le message d'erreur.
- Gate capabilities FR-03 : verification agent existant + capacites avant acceptation.

## 04 — ollama-cloud/hermes : processus vivant mais gelee (2 occurrences)
**Symptome** : Deux dispatches consecutifs sur le chemin `ollama-cloud` + `hermes -z --yolo` ont produit la meme signature de gel :

| Tache | PID | Symptome mesure |
|---|---|---|
| #508 | 24592 | CPU (Kernel+User) = 0, RSS ~4,5 MB, zero ecriture log, aucun diff apres ~11 min en `in_progress` |
| #524 | 13824 | CPU = 0, RSS ~4,4 MB, aucune progression apres ~8 min |

Le process existe (vivant au sens PID) mais ne calcule rien : blocage probable de la connexion Ollama Cloud sans timeout applicatif.
**Cause** : `hermes.exe` lance en mode `-z` headless se bloque sur l'appel au provider cloud (connexion ou prompt interactif non couvert par `--yolo`) sans timeout interne. L'orchestrateur ne distinguait pas "worker vivant" de "worker fige" : le statut DB restait `in_progress` tant que le PID existait.
**Correction** : - Kill des deux PID ; #508 et #524 marquees `failed` ; scopes repris par agent-Devin (FR-05/06/07 pour 508 ; patch extension pour 524).
- FR-08 : heartbeat worker — le bridge bat `last_heartbeat` toutes les 30 s uniquement si le PID vit ET que le log de dispatch progresse (`log=` dans l'event dispatched) ; un worker gelee-mais-vivant cesse d'emettre des beats et est reape `failed` apres 10 min.
- Regle de veille transmise au relais : `in_progress` > ~30 min sans artefact = suspect ; verifier PID + CPU + mtime log, pas seulement le statut DB.
- Timeout abort 300 s ajoute aux workers NIM ; recommandation de ne pas redispatcher sur `ollama-cloud` sans timeout/reaper effectif.

## 05 — hphe-mcp.exe : process stale, gates deployees mais non appliquees
**Symptome** : Apres deploiement de la Phase 1 (gates FR-01 a FR-04), la tache #520 — une mission `explore` exigeant `fs_read` — a ete dispatchee avec succes vers `nim1` dont `capabilities=["text_only"]`. Le gate FR-03 aurait du refuser : il n'a pas bloque.
**Cause** : Quatre process `hphe-mcp.exe` etaient actifs depuis avant le deploiement (heures de demarrage 13:38/02:13, deploye ~04:15). Windows permet le rename/copy d'un exe en cours (strategie `.old` + copie), mais les process deja lances gardent l'ancien code en memoire. Le dispatch de #520 est passe par l'un de ces process stale : les nouvelles gates n'y existaient pas.
**Correction** : - Alerte transmise a agent-AGY : les gates n'ont d'effet qu'au recyclage des process MCP.
- Documentation : tout deploiement de `hphe-mcp.exe` impose une rotation des sessions MCP actives (reload fenetre IDE ou reconnexion des clients) pour etre effectif.
- Compensations transitoires : veille agent-Devin a intercepte le livrable factice de #520 (nim1 incapable d'ecrire) ; la tache a ete requalifiee `failed`.

## 06 — watchdog et reveil agycascade : conception du canal reactif
**Symptome** : A plusieurs reprises dans la nuit, aucune tache n'etait `in_progress` alors que du travail `pending` existait — personne ne detectait le vide de queue. Les wakes vers agent-AGY dependaient de lectures passives de `comms.jsonl`.
**Cause** : Absence de sonde dediee : la supervision reposait sur des verifications manuelles. Les transitions de statut et les anomalies (deps non resolues, provider desactive, worker inactif, DB inerte) n'avaient pas de chemin d'alerte proactif vers l'orchestrateur.
**Correction** : - `watchdog.ps1` : daemon PowerShell — `System.Timers.Timer` (30-60 s) + `FileSystemWatcher` sur `comms.jsonl` pour declenchement immediat ; sondes MCP (`list_tasks`, `list_agents`, `hphe_health`), CPU CIM, process workers, mtime `orchestrator.db`/`-wal` (jamais de SQL direct), bridge :7477, hub AGY, inventaire ACP.
- Alertes dedupliquees (`alerts`, `taskFirstSeen`, `taskStatuses`, `wokenTasks` persistes dans `watch-state.json`) ; agregation en notes et envoi Connect-RPC direct vers la cascade agent-AGY via `agy-hub.js send <cascade> --model <modele>`.
- Routage `[agycascade:<uuid>]` dans les titres de taches : propage la cascade cible pour les retours de resultat ; le watchdog ne reeveille…

## 07 — extension hephaistos-kit-search 1.0.5 : correctifs webview et packaging VSIX
**Symptome** : Deux bugs sur l'extension `hephaistos-kit-search` :

1. **Persistance** : les dossiers epingles/deposes (`dirFavChips`, `crumbsEl`) disparaissaient au reload — l'etat reposait sur `vscode.setState()` cote webview, volatile.
2. **Creation fs** : `actNewFile`/`actNewDir`/`_fsCreate` echouaient ou ciblaient un mauvais repertoire sans ligne selectionnee — `dirForCreate()` ne regardait que `selectedItems()` et renvoyait `null` en mode browse.
**Cause** : Etat de navigation confie a la couche volatile webview plutot qu'a `context.workspaceState`/`globalState` cote extension host ; resolution du repertoire cible non contextualisee (pas de fallback `state.cwd` -> racine workspace).
**Correction** : - IPC bidirectionnel `saveFolderHistory`/`getFolderHistory` dans `searchView.js` ; persistance dans `context.globalState` (cle `panelState`), injection a `resolveWebviewView` via `window.__HPHE_BOOT__`.
- Resolution en cascade : selection (dossier) -> parent (fichier) -> `state.cwd` (browse) -> racine workspace ; indicateur visuel de cible ; refresh apres `fsCreated`.
- Rebuild et packaging `hephaistos-kit-search-1.0.5.vsix` (10,7 MB) conserve dans `extension/` sans installation — installation sur validation l'utilisateur uniquement.

## 08 — gouvernance dispatch : priorite workers Cloud CLI vs collaborateurs ACP
**Symptome** : Les collaborateurs ACP (Devin/agent-Devin, AGY/agent-AGY, sessions binome) etaient sollicites pour des taches deleguables (docs, specs, triage) alors que des workers Cloud CLI gratuits etaient disponibles. Reciproquement, des workers `text_only` recevaient des missions fichiers qu'ils ne pouvaient pas executer (#500, #509, #520 — voir rapport 01).
**Cause** : Absence de politique d'affectation explicite : le dispatch choisissait par disponibilite de provider sans tenir compte ni du cout, ni des capabilities effectives. Double consequence : saturation des ACP (contexte humain couteux) et dispatches impossibles a honorer (text_only + fichiers).
**Correction** : - Regle editee par le l'utilisateur dans `.<id>.md` et `.agent/rules/rapport-dysfonctionnement.md` : l'orchestrateur ne code jamais lui-meme (verification + dispatch uniquement) et priorise les workers Cloud CLI (`nim1`, `nim2`, `ollama-cloud`) via `dispatch_task`.
- Matrice d'affectation :
  - `text_only` (nim1/nim2) -> docs, specs, explore ; livrables sous `.agent/deliverables/` verifies par `gateArtifact`.
  - `fs_read`/`fs_write`/`cmd` (ACP) -> taches fichiers, code, deploiement.
  - Dispatch refuse si capabilities insuffisantes (FR-03).
- Circuit breaker FR-07 sur les providers cloud defaillants ; reaper FR-08 sur les workers figes (signature hermes/ollama-cloud documentee, rapport 04).

## 09 — spawn workspace : os error 123 (chemin/template non substitue)
**Symptome** : Des spawns de workers echouaient avec `spawn ... os error 123` — code Win32 `ERROR_INVALID_NAME` : le nom de fichier, de repertoire ou le libelle de volume est incorrect. Le process worker ne demarrait meme pas ; la tache pouvait rester `in_progress` sans process.
**Cause** : `template_to_spawn_plan` interpolait le template de spawn sans substituer le jeton `{workspace}`. La ligne de commande resultante contenait le litteral `{workspace}` (accolades invalides dans un chemin Windows), rejetee par `CreateProcessW` avec `os error 123`. Aggrave par 6 entrees `prompt_templates` legataires obsoletes encore actives en DB, dont certaines portaient d'autres jetons non substitues.
**Correction** : - Correction de `template_to_spawn_plan` : substitution systematique de `{workspace}` par la racine workspace resolue avant construction de la cmdline.
- Purge des 6 `prompt_templates` legataires ; `seed-orchestrator.mjs` rendu idempotent (pas de reinsertion des templates obsoletes, preservation de `capabilities`/`full_prompt`).
- Les plans de spawn restants n'utilisent que des arguments tableaux (pas d'interpolation shell).

## 10 - Audit de securite Hephaistos 2.1
**Symptome** : Mission : audit de securite complet du code livre dans la nuit pour Hephaistos 2.1, selon cinq controles obligatoires : injection shell, eval/code obfusque, parametrisation SQLite, fuites de secrets, path traversal. Le rapport ci-dessous consolide les constats preuves a l'appui (references fichier:ligne verifiees), les ecarts trouves et les corrections recommandees.
**Correction** : Durcissement applique post-audit (commit nuit 2, tache #548) :

- **F1** : `tool_list_tasks` (orch.rs) — `status` et `assigned_to` lies via `params_from_iter`/`?`, interpolation SQL supprimee.
- **F2** : `gateArtifact` (nim-worker.mjs) — confinement `realpath`/`relative` sous la racine de la tache (`workspace` DB sinon cwd) + fichier regulier non vide + `mtime > created_at`.
- **F3** : `verify_expected_artifact` (orch.rs) — `canonicalize` + `starts_with(workspace)` quand la tache porte un workspace ; exige fichier regulier non vide.
- **F4** : `project_init`/`scaffold_workspace` (memory.rs) — `confine_workspace` borne le scaffold ; ajout `check_project_id` (charset `[A-Za-z0-9_-]` <=64) sur…

## 12 - Crashes recurrents de l'IDE Devin : epuisement memoire systeme (OOM)
**Symptome** : L'IDE Devin "plante" a repetition dans la nuit : fenetre renderer morte, workers ACP orphelins, redemarrages en cascade. Dumps Crashpad recurrents depuis le 07/10 (5 dumps, jusqu'a 38 Mo).
**Cause** : **Epuisement memoire systeme, pas un bug applicatif.**

- `crash.json` : `reason: "oom"`, `exitCode: -<id>`, 2026-10-19T03:42:21Z. `main.log` : `CodeWindow: detected unresponsive` (05:00 local), `renderer process gone (crashed, -36861)` (05:33), `renderer process gone (oom, -<id>)` (05:42).
- Machine : **RAM 15,9 Go, 1,7 Go libre (~90 %) ; commit charge 28,2/31,9 Go (~88 %)** ; 403 processus.
- L'ecosysteme Devin seul pese **9,4 Go** : Devin 19 proc/4,75 Go (renderer max 3,09 Go), node 38/1,32 Go (serveurs MCP x fenetres + bridges + workers), opencode 4/1,36 Go, pwsh 17/735 Mo, kilo 670 Mo, llama-server 444 Mo, agy 252 Mo. + Obsidian ~1 Go, MsMpEng 527 Mo hors perimetre.
- Signature…
**Correction** : - **Pagefile C: porte de 16384 -> 32768 Mo** (`Win32_PageFileSetting`, taille fixe) — commit limit passera de ~32 a ~48 Go au prochain reboot. L'allocation live reste 16384 jusqu'au redemarrage : maintenir la diete memoire d'ici la.
- Chemin GUI de controle : `SystemPropertiesAdvanced` > Performances > Avance > Memoire virtuelle > Modifier > C: > Taille personnalisee 32768/32768 > Definir.

Recommandations complementaires (ordre d'impact) :

1. **Une seule fenetre Devin** sur ce workspace — ferme window3/window6 (libere ~2 renderers + 2 exthosts + ~30 node MCP, ~2-3 Go).
2. **Couper les locataires inactifs** : opencode x4, llama-server, Obsidian si non requis (~2,8 Go recuperables).
3.…

## 17 — Herald OS : chaine VPN Delirium non persistante au reboot + perte LAN lors du `up`
**Symptome** : - Fenetres privees du PC qui « moulinent » : trafic `<vpn-user>` sans route (tunnel absent).
- Bureau Herald OS affiche son fond d'ecran — interprete comme une veille ou un crash ; en realite la session niri/hermes tournait normalement (swayidle anti-veille deja cable, sleep/suspend/hibernate deja `masked`).
- Reboots nocturnes inopines effacant l'etat operationnel.
**Cause** : 1. **`bootc-fetch-apply-updates.timer`** actif : appliquait les mises a jour bootc et rebootait la machine la nuit.
2. **`<wg-iface>-direct.service` et `<wg-iface>-lanfix.service` en `disabled`** : le daemon VPN et le watchdog LAN ne remontaient jamais apres reboot ; `cerber-canal` demarrait mais sans interface `<wg-iface>` a router.
3. **Groupe `<wg-iface>` absent** : `chgrp` du socket daemon en echec, socket `root:root`, client `<vpn-user>` incapable de dialoguer avec le daemon.
4. **Pas d'unite auto-`up`** : `<wg-iface> up` etait une operation manuelle ; aucun mecanisme ne montait le tunnel au boot.
5. **Ordre de mise en route casse** : un `<wg-iface> up` lance avant `<wg-iface>-lanfix`…
**Correction** : | Action | Resultat |
|---|---|
| `groupadd -r <wg-iface>` + `usermod -aG <wg-iface> <vpn-user>` | Socket `root:<wg-iface>`, `chgrp` OK |
| `systemctl enable <wg-iface>-direct <wg-iface>-lanfix` | Persistance au reboot (symlinks `/etc`, preserves par bootc/ostree) |
| `systemctl disable --now bootc-fetch-apply-updates.timer` | Plus de reboot nocturne non maitrise ; MAJ manuelle via `bootc upgrade` |
| Nouvelle unite `<wg-iface>-autoup.service` (oneshot, `After=direct+lanfix`, `Before=cerber-canal`, retry 5x5s) | `<wg-iface> up` automatique a chaque boot |
| `restart <wg-iface>-direct` → `start lanfix` → `<wg-iface> up` → `restart cerber-canal` | Chaine montee dans l'ordre, SSH preserve |

## 19 — Herald OS : canal prive KO (tunnel SSH -D 1080 absent cote PC)
**Symptome** : - Pages de navigation privee du PC sans egress : l'extension CerberCanal pointe
  `socks5://127.0.0.1:1080`, mais rien n'ecoutait sur ce port.
**Cause** : Fragilite connue (rapport 18, « Reste ouvert ») : les forwards PC (`-D 1080`,
`-L 5900`) sont des process ad-hoc non supervises — le canal meurt a chaque
reboot sans relance automatique. Le laptop, lui, etait operationnel.

## Dysfonctionnement — routage des livrables nim-worker
**Symptome** : Les tasks dispatchées via `dispatch_task` vers `nim1`/`nim2` s'exécutent (pid réel, appels NIM OK quand le modèle est vivant) mais retombent systématiquement en `failed` avec :

```
expected_artifact non satisfait: artifact absent ou illisible: <workspace>\...
```
**Cause** : `nim-worker.mjs` écrit le livrable dans **son propre répertoire `.agent`** du kit :
`<chemin> Files\Projet-complet\hephaistos2-kit\.agent\agent-bridge\<fichier>`
au lieu du workspace cible de la tâche (`{workspace}` de la commande agent).

La porte `expected_artifact` vérifie le fichier **dans le workspace** → absent → `failed`,
même quand le worker a réellement produit un fichier.

## 21 — Restauration du token du bridge WebSocket
**Symptome** : Le panneau Hephaistos Chats ne se connectait pas au bridge et le chat ne
demarrait pas. L'injection ACP fonctionnait toujours, car elle emprunte un
transport distinct du WebSocket du panneau.
**Cause** : Le port `7477` etait deja occupe par l'instance officielle de
`ws-bridge/bridge.js` lancee par Devin. Le workspace actif ne disposait pas de
`.agent/ws-bridge.token`. Le client de l'extension, qui cherche d'abord
`ORCH_MONITOR_TOKEN` puis le fichier du workspace, envoyait donc l'upgrade sans
secret. Le bridge le rejetait avec `HTTP 401`.

Un ancien demarrage en double avait aussi produit `EADDRINUSE`. Ce journal
historique ne justifiait pas de tuer le listener valide.

Le token n'est pas un credential de fournisseur IA et ne change pas a chaque
connexion. C'est un secret d'authentification du bridge. Il est stable tant
qu'il n'est pas remplace. Le secret configure actuellement est partage…

## 23 — Extension hephaistos-chats : onglets ComfyUI et n8n casses (0.3.42 -> 0.3.46)
**Symptome** : - Onglet n8n : `n8n-auth-proxy: login n8n KO (401)` en boucle.
- Onglet ComfyUI : fenetre grise, aucune interface.
- Les rebuilds n'avaient aucun effet visible dans l'IDE.
**Cause** : 1. **Creds vides injectees au proxy n8n** — `ensureServiceOnce` passait
   `N8N_EMAIL: ''` / `N8N_PASSWORD: ''` dans l'env du proxy, ce qui ecrasait les
   valeurs du `.env` lues par `n8n-auth-proxy.mjs` (priorite `process.env`).
   Fix : ne passer que les cles non vides (`proxyEnv` filtre).

2. **`resolveComfyUI` ne trouvait que les launchers dev** — recherche limitee a
   `comfyui.cmd|bat` / `run_nvidia_gpu.bat` sur PATH. Le backend cible est le
   `Comfy Desktop.exe` deja lance (`<chemin> Desktop\Comfy Desktop.exe`).
   Fix : la fonction ne resout plus QUE l'exe (toutes references .bat/dev supprimees).

3. **`comfyui-proxy` jamais spawne** — `ensureServiceOnce('comfyui')` faisait
   `if…
**Correction** : | Version | Contenu |
|---------|---------|
| 0.3.42 | filtre creds proxy + resolveComfyUI exe-only (build casse puis restaure) |
| 0.3.43 | ports par defaut `:8000` (extension + `COMFYUI_LOCAL` dans le proxy) |
| 0.3.44 | ajout spawn `comfyui-proxy.mjs` sur `:8190` |
| 0.3.45 | retrait du `return true` premature qui sautait le spawn du proxy |
| 0.3.46 | iframe webview `:8188` -> `:8190` |

Deploiement : VSIX installee via `Extensions: Install from VSIX` + copie dans
`.devin/extensions/hephaistos.hephaistos-chats-0.3.46` + `extensions.json` a jour.
