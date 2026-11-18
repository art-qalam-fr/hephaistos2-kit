-- ============================================================================
-- Couche SCOPE local/global — mémoire unifiée Hephaistos
-- DB canonique : $AGENT_DB_ROOT/current_workspace/graph/memory_mcp.db
--
-- Principe :
--   scope='global'  → méthodologie de travail, réflexologie des agents,
--                     consciousness, knowledge, taxonomies partagées.
--                     Commun à TOUS les projets — ne jamais y mettre de
--                     substance propre à un projet.
--   scope='project' → substance propre au projet : fichiers, chunks,
--                     décisions projet, contexte local.
--
-- Vectoriel : zvec (local MiniLM 384d) = recherche fine ;
--             qdrant (NVIDIA nemotron 2048d) = recherche large/catégorique.
-- ============================================================================

CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'workspace',   -- workspace | project | global
  root_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entity_scope (
  entity_id INTEGER PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('global','project')),
  project TEXT,                            -- nom du projet si scope='project', NULL si global
  kind TEXT,                               -- file|chunk|workspace|project|technology|tool|tag|other
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_entity_scope ON entity_scope(scope, project);
CREATE INDEX IF NOT EXISTS idx_entity_scope_kind ON entity_scope(kind);

CREATE VIEW IF NOT EXISTS v_scoped_entities AS
SELECT e.id, e.name, e.entityType,
       COALESCE(s.scope, 'project') AS scope,
       s.project, COALESCE(s.kind, e.entityType) AS kind
FROM entities e LEFT JOIN entity_scope s ON s.entity_id = e.id;

-- ============================================================================
-- Règles de backfill (rejouables, INSERT OR IGNORE)
-- ============================================================================

-- 1) Registre des projets depuis les entités workspace:/project:
INSERT OR IGNORE INTO projects(name, kind)
SELECT CASE WHEN instr(name,':')>0 THEN substr(name, instr(name,':')+1) ELSE name END,
       entityType
FROM entities WHERE entityType IN ('workspace','project');

-- 2) Types explicitement globaux (méthodologie / réflexologie partagée)
INSERT OR IGNORE INTO entity_scope(entity_id, scope, kind)
SELECT id, 'global', entityType FROM entities
WHERE entityType IN ('technology','mcp_tool','tool_integration','user',
                     'workspace_list','tag','container');

-- 3) workspace:X / project:X → project=X
INSERT OR IGNORE INTO entity_scope(entity_id, scope, project, kind)
SELECT id, 'project',
       CASE WHEN instr(name,':')>0 THEN substr(name, instr(name,':')+1) ELSE name END,
       entityType
FROM entities WHERE entityType IN ('workspace','project');

-- 4) file/chunk → projet résolu via relation 'contains' depuis workspace:X
INSERT OR IGNORE INTO entity_scope(entity_id, scope, project, kind)
SELECT e.id, 'project',
       (SELECT substr(r.from_entity, instr(r.from_entity,':')+1)
        FROM relations r
        WHERE r.to_entity = e.name AND r.from_entity LIKE 'workspace:%'
        LIMIT 1),
       e.entityType
FROM entities e WHERE e.entityType IN ('file','chunk');

-- 5) Tout le reste → scope project, projet NULL (à affiner)
INSERT OR IGNORE INTO entity_scope(entity_id, scope, kind)
SELECT id, 'project', entityType FROM entities;


-- ============================================================================
-- ============================================================================
-- EXTENSION v2 — index complémentaires, promotion 'global', peuplement FTS5,
--                backfill projects.root_path
-- Appliquée à chaud par memory-maintenance.ps1 : tout est idempotent
-- (CREATE INDEX IF NOT EXISTS / upsert DO UPDATE...WHERE / gardes NOT EXISTS).
-- Mesures réalisées sur memory_mcp.db (SQLite 3.49, WAL) — oct. 2025.
-- ============================================================================
-- ============================================================================

-- ============================================================================
-- A. INDEX COMPLÉMENTAIRES
-- ============================================================================
-- Volontairement NON créés (déjà couverts, un index serait redondant) :
--   * entity_scope(entity_id) : INTEGER PRIMARY KEY = alias du rowid →
--     lookup direct B-tree, aucun index secondaire nécessaire.
--   * entities(name)          : UNIQUE → sqlite_autoindex_entities_1.
--   * relations(from_entity, to_entity) : préfixe gauche de
--     sqlite_autoindex_relations_1 (UNIQUE from,to,relationType).
--     NB : idx_relations_from est lui-même redondant avec ce préfixe —
--          `DROP INDEX IF EXISTS idx_relations_from;` possible sans perte
--          (laissé en place : coût d'écriture faible, risque nul).

-- WHERE entityType IN (...) — utilisé par tous les backfills scope et la vue.
CREATE INDEX IF NOT EXISTS idx_entities_type      ON entities(entityType);

-- Filtres/agrégations par type de relation (contains=70%, has_tag=30%).
CREATE INDEX IF NOT EXISTS idx_relations_type     ON relations(relationType);

-- Jointure inverse : WHERE to_entity=? AND from_entity=? et la sous-requête
-- corrélée du backfill n°4 (r.to_entity=e.name AND r.from_entity LIKE
-- 'workspace:%'). Le sens (from,to) est déjà couvert par l'autoindex UNIQUE.
CREATE INDEX IF NOT EXISTS idx_relations_to_from  ON relations(to_entity, from_entity);

-- WHERE project=? sans filtre sur scope : idx_entity_scope(scope,project)
-- n'est utilisable que par préfixe gauche — cet index couvre le cas isolé.
CREATE INDEX IF NOT EXISTS idx_entity_scope_project ON entity_scope(project);

-- NOTE : pas d'index B-tree utile sur observations.content — un LIKE '%...%'
-- à joker initial ne peut jamais l'utiliser. C'est le rôle de memory_fts (C).


-- ============================================================================
-- B. PROMOTION scope='global' — fichiers .agent/knowledge | .agent/consciousness
-- ============================================================================
-- Les entités file:/chunk: dont une observation path= ou Source: référence
-- .agent/knowledge/ ou .agent/consciousness/ (séparateur / ou \ Windows)
-- relèvent de la MÉTHODOLOGIE partagée → scope='global', project=NULL.
-- Impact mesuré : ~115 entités.
--
-- Upsert idempotent : INSERT pour les entity_id absents de entity_scope,
-- DO UPDATE...WHERE pour les existantes ; la clause WHERE rend le rejeu
-- totalement no-op sur les lignes déjà globales (updated_at non retouché).

INSERT INTO entity_scope(entity_id, scope, project, kind, updated_at)
SELECT DISTINCT e.id, 'global', NULL, e.entityType, CURRENT_TIMESTAMP
FROM entities e
JOIN observations o ON o.entity_id = e.id
WHERE e.entityType IN ('file','chunk')
  AND ( o.content LIKE '%.agent/knowledge%'
     OR o.content LIKE '%.agent\knowledge%'
     OR o.content LIKE '%.agent/consciousness%'
     OR o.content LIKE '%.agent\consciousness%' )
ON CONFLICT(entity_id) DO UPDATE SET
    scope      = 'global',
    project    = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE entity_scope.scope <> 'global';

-- Affinage optionnel du kind pour les entités promues (décommenter si souhaité) :
-- UPDATE entity_scope SET kind = 'knowledge' WHERE scope = 'global'
--   AND entity_id IN (SELECT o.entity_id FROM observations o
--                     WHERE o.content LIKE '%.agent/knowledge%'
--                        OR o.content LIKE '%.agent\knowledge%');


-- ============================================================================
-- C. PEUPLEMENT memory_fts (FTS5) — graphe → recherche plein texte
-- ============================================================================
-- Schéma mesuré : memory_fts(memory_id, content, user_id, session_id, category)
--   tokenize='porter unicode61' — table FTS5 autonome (pas de content=externe).
-- La FTS est dimensionnée pour `memories` ; on y indexe le graphe via un
-- namespace sur memory_id ET sur rowid :
--   rowid > 0              → 'obs:'||observations.id  (contenu des observations)
--   rowid < 0              → 'ent:'||entities.id      (noms d'entités)
--   rowid >= 1_000_000_000 → réservé aux lignes 'mem:' (futures syncs memories)
--
-- Idempotent : la garde NOT EXISTS(rowid) fait du rejeu un INSERT du delta
-- uniquement — c'est aussi le mécanisme de sync incrémentale (section D, opt.1).
-- user_id='graph' : sentinel pour les lignes issues du graphe (reste cohérent
-- avec memories.user_id NOT NULL).

-- C.1 Noms d'entités (rowid négatif)
INSERT INTO memory_fts(rowid, memory_id, content, user_id, session_id, category)
SELECT -e.id, 'ent:'||e.id, e.name, 'graph', NULL, e.entityType
FROM entities e
WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.rowid = -e.id);

-- C.2 Observations (rowid = observations.id)
-- content = nom d'entité + contenu : un MATCH sur le nom retrouve aussi ses
-- observations.
INSERT INTO memory_fts(rowid, memory_id, content, user_id, session_id, category)
SELECT o.id, 'obs:'||o.id, e.name || ' ' || o.content, 'graph', NULL, e.entityType
FROM observations o
JOIN entities e ON e.id = o.entity_id
WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.rowid = o.id);

-- Vérification : SELECT count(*) FROM memory_fts;
-- Recherche     : SELECT memory_id, snippet(memory_fts,1,'[',']','…',12)
--                 FROM memory_fts WHERE memory_fts MATCH 'knowledge' LIMIT 20;


-- ============================================================================
-- D. SYNCHRONISATION FTS — deux options au choix
-- ============================================================================
-- OPTION 1 (ACTIVE — recommandée) : batch incrémental.
--   Les INSERT de la section C sont rejoués par memory-maintenance.ps1 à
--   chaque passe ; la garde NOT EXISTS n'insère que le delta. Zéro surcoût
--   sur les écritures des daemons, aucun risque de blocage.
--
-- OPTION 2 (EN ATTENTE — décommenter pour sync temps réel) : triggers AFTER.
--   Attention : chaque INSERT sur observations paie ~+1 écriture FTS5, et si
--   memory_fts est verrouillée/corrompue les écritures daemons échouent.
--   N'activer que si la fraîcheur temps réel est indispensable.
--
-- CREATE TRIGGER IF NOT EXISTS trg_obs_fts_ai AFTER INSERT ON observations
-- BEGIN
--   INSERT INTO memory_fts(rowid, memory_id, content, user_id, session_id, category)
--   SELECT NEW.id, 'obs:'||NEW.id, e.name || ' ' || NEW.content, 'graph', NULL, e.entityType
--   FROM entities e WHERE e.id = NEW.entity_id;
-- END;
--
-- CREATE TRIGGER IF NOT EXISTS trg_obs_fts_ad AFTER DELETE ON observations
-- BEGIN
--   DELETE FROM memory_fts WHERE rowid = OLD.id;
-- END;
--
-- CREATE TRIGGER IF NOT EXISTS trg_obs_fts_au AFTER UPDATE OF content ON observations
-- BEGIN
--   DELETE FROM memory_fts WHERE rowid = OLD.id;
--   INSERT INTO memory_fts(rowid, memory_id, content, user_id, session_id, category)
--   SELECT NEW.id, 'obs:'||NEW.id, e.name || ' ' || NEW.content, 'graph', NULL, e.entityType
--   FROM entities e WHERE e.id = NEW.entity_id;
-- END;
--
-- CREATE TRIGGER IF NOT EXISTS trg_ent_fts_ai AFTER INSERT ON entities
-- BEGIN
--   INSERT INTO memory_fts(rowid, memory_id, content, user_id, session_id, category)
--   VALUES(-NEW.id, 'ent:'||NEW.id, NEW.name, 'graph', NULL, NEW.entityType);
-- END;
--
-- CREATE TRIGGER IF NOT EXISTS trg_ent_fts_au AFTER UPDATE OF name ON entities
-- BEGIN
--   DELETE FROM memory_fts WHERE rowid = -OLD.id;
--   INSERT INTO memory_fts(rowid, memory_id, content, user_id, session_id, category)
--   VALUES(-NEW.id, 'ent:'||NEW.id, NEW.name, 'graph', NULL, NEW.entityType);
-- END;
--
-- CREATE TRIGGER IF NOT EXISTS trg_ent_fts_ad AFTER DELETE ON entities
-- BEGIN
--   DELETE FROM memory_fts WHERE rowid = -OLD.id;
-- END;
--
-- NB : les suppressions d'observations orphelines sans trigger peuvent être
-- rattrapées en batch : DELETE FROM memory_fts WHERE rowid > 0 AND
--   rowid NOT IN (SELECT id FROM observations);  (idem avec <0 / entities)


-- ============================================================================
-- E. BACKFILL projects.root_path — SECTION COMMENTÉE (revue manuelle requise)
-- ============================================================================
-- Mapping généré depuis le disque <TOOLS_ROOT> : 128/138 résolus.
-- Requiert SQLite >= 3.33 (UPDATE..FROM). Idempotent : ne touche que les
-- lignes dont root_path est NULL ou différent. Décommenter le bloc entier.
--
-- UPDATE projects AS p
-- SET root_path = m.root_path
-- FROM (
--       SELECT '432z' AS name,'<TOOLS_ROOT>/432z' AS root_path UNION ALL
--       SELECT '4D-Systems-Framework','<TOOLS_ROOT>/4D-Systems-Framework' UNION ALL
--       SELECT 'Agent-Reach','<TOOLS_ROOT>/Agent-Reach' UNION ALL
--       SELECT 'ArchNext-IDE','<TOOLS_ROOT>/ArchNext-IDE' UNION ALL
--       SELECT 'AutoGPT','<TOOLS_ROOT>/AutoGPT' UNION ALL
--       SELECT 'CADAM','<TOOLS_ROOT>/CADAM' UNION ALL
--       SELECT 'CerbereShield','<TOOLS_ROOT>/CerbereShield' UNION ALL
--       SELECT 'ComfyUI/ComfyUI','<TOOLS_ROOT>/ComfyUI/ComfyUI' UNION ALL
--       SELECT 'ComfyUI/ComfyUI-Manager','<TOOLS_ROOT>/ComfyUI/ComfyUI-Manager' UNION ALL
--       SELECT 'Component','<TOOLS_ROOT>/Component' UNION ALL
--       SELECT 'Cryptage','<TOOLS_ROOT>/Cryptage' UNION ALL
--       SELECT 'CustomTkinter','<TOOLS_ROOT>/CustomTkinter' UNION ALL
--       SELECT 'Dafnck-Machine-3.3-main','<TOOLS_ROOT>/Dafnck-Machine-3.3-main' UNION ALL
--       SELECT 'Flowise','<TOOLS_ROOT>/Flowise' UNION ALL
--       SELECT 'Folio-OCR','<TOOLS_ROOT>/Folio-OCR' UNION ALL
--       SELECT 'Gemini-CLI-UI','<TOOLS_ROOT>/Gemini-CLI-UI' UNION ALL
--       SELECT 'Hephaistos-Kit','<TOOLS_ROOT>/Hephaistos-Kit' UNION ALL
--       SELECT 'Hostinger-n8n','<TOOLS_ROOT>/Hostinger-n8n' UNION ALL
--       SELECT 'Kiro-teste','<TOOLS_ROOT>/Kiro-teste' UNION ALL
--       SELECT 'LLM_Web_search_OWUI','<TOOLS_ROOT>/LLM_Web_search_OWUI' UNION ALL
--       SELECT 'LibreTranslate','<TOOLS_ROOT>/LibreTranslate' UNION ALL
--       SELECT 'MCP-n8n-Client','<TOOLS_ROOT>/MCP-n8n-Client' UNION ALL
--       SELECT 'Mon_wesprflow_python_local','<TOOLS_ROOT>/Mon_wesprflow_python_local' UNION ALL
--       SELECT 'Monkey EML (SRTE)','<TOOLS_ROOT>/Monkey EML (SRTE)' UNION ALL
--       SELECT 'Moteur-simulation-photonique','<TOOLS_ROOT>/Moteur-simulation-photonique' UNION ALL
--       SELECT 'OmniRoute','<TOOLS_ROOT>/OmniRoute' UNION ALL
--       SELECT 'PyQt-Fluent-Widgets','<TOOLS_ROOT>/PyQt-Fluent-Widgets' UNION ALL
--       SELECT 'Qwen','<TOOLS_ROOT>/Qwen' UNION ALL
--       SELECT 'Rag-OCR','<TOOLS_ROOT>/Rag-OCR' UNION ALL
--       SELECT 'React_exemple/react-flow','<TOOLS_ROOT>/React_exemple/react-flow' UNION ALL
--       SELECT 'React_exemple/xyflow','<TOOLS_ROOT>/React_exemple/xyflow' UNION ALL
--       SELECT 'RobloxStarter','<TOOLS_ROOT>/RobloxStarter' UNION ALL
--       SELECT 'Rovo_code_Atlassian','<TOOLS_ROOT>/Rovo_code_Atlassian' UNION ALL
--       SELECT 'SRTE v1.1','<TOOLS_ROOT>/SRTE v1.1' UNION ALL
--       SELECT 'SRTE v1.1 - Copie/scripts','<TOOLS_ROOT>/SRTE v1.1 - Copie/scripts' UNION ALL
--       SELECT 'SVGcode','<TOOLS_ROOT>/SVGcode' UNION ALL
--       SELECT 'Sigil Forge','<TOOLS_ROOT>/Sigil Forge' UNION ALL
--       SELECT 'TRELLIS.2','<TOOLS_ROOT>/TRELLIS.2' UNION ALL
--       SELECT 'Telegram-Drive','<TOOLS_ROOT>/Telegram-Drive' UNION ALL
--       SELECT 'The-scrybe-Electron','<TOOLS_ROOT>/The-scrybe-Electron' UNION ALL
--       SELECT 'Thot-Agents','<TOOLS_ROOT>/Thot-Agents' UNION ALL
--       SELECT 'Vllm-tensort','<TOOLS_ROOT>/Vllm-tensort' UNION ALL
--       SELECT 'Vllm-tensort+','<TOOLS_ROOT>/Vllm-tensort+' UNION ALL
--       SELECT 'Vllm-tensort+vllm-py311','<TOOLS_ROOT>/Vllm-tensort+vllm-py311' UNION ALL
--       SELECT 'Website-downloader','<TOOLS_ROOT>/Website-downloader' UNION ALL
--       SELECT 'Windsurf-Paramétrage-et corection','<TOOLS_ROOT>/Windsurf-Paramétrage-et corection' UNION ALL
--       SELECT 'a2a-vscode-client','<TOOLS_ROOT>/a2a-vscode-client' UNION ALL
--       SELECT 'accomplish','<TOOLS_ROOT>/accomplish' UNION ALL
--       SELECT 'agentMemory','<TOOLS_ROOT>/agentMemory' UNION ALL
--       SELECT 'ai-agents-masterclass','<TOOLS_ROOT>/ai-agents-masterclass' UNION ALL
--       SELECT 'airllm','<TOOLS_ROOT>/airllm' UNION ALL
--       SELECT 'antigravity-awesome-skills','<TOOLS_ROOT>/antigravity-awesome-skills' UNION ALL
--       SELECT 'automatisch','<TOOLS_ROOT>/automatisch' UNION ALL
--       SELECT 'bolt.diy','<TOOLS_ROOT>/bolt.diy' UNION ALL
--       SELECT 'buzz','<TOOLS_ROOT>/buzz' UNION ALL
--       SELECT 'cerbere_public_export','<TOOLS_ROOT>/cerbere_public_export' UNION ALL
--       SELECT 'claude-code-ui-agents','<TOOLS_ROOT>/claude-code-ui-agents' UNION ALL
--       SELECT 'claude-projets','<TOOLS_ROOT>/claude-projets' UNION ALL
--       SELECT 'claude-task-master','<TOOLS_ROOT>/claude-task-master' UNION ALL
--       SELECT 'convertiseur-LLm','<TOOLS_ROOT>/convertiseur-LLm' UNION ALL
--       SELECT 'creator-of-workspace-agentic','<TOOLS_ROOT>/creator-of-workspace-agentic' UNION ALL
--       SELECT 'cursorrules','<TOOLS_ROOT>/cursorrules' UNION ALL
--       SELECT 'desk-top-comun','<TOOLS_ROOT>/desk-top-comun' UNION ALL
--       SELECT 'desktop-build','<TOOLS_ROOT>/desktop-build' UNION ALL
--       SELECT 'dots','<TOOLS_ROOT>/dots' UNION ALL
--       SELECT 'effective-html','<TOOLS_ROOT>/effective-html' UNION ALL
--       SELECT 'flash-attention','<TOOLS_ROOT>/flash-attention' UNION ALL
--       SELECT 'flow n8n','<TOOLS_ROOT>/flow n8n' UNION ALL
--       SELECT 'flyde','<TOOLS_ROOT>/flyde' UNION ALL
--       SELECT 'free-llm-api-resources','<TOOLS_ROOT>/free-llm-api-resources' UNION ALL
--       SELECT 'gemini-cli','<TOOLS_ROOT>/gemini-cli' UNION ALL
--       SELECT 'gemini-for-claude-code','<TOOLS_ROOT>/gemini-for-claude-code' UNION ALL
--       SELECT 'groq-appgen','<TOOLS_ROOT>/groq-appgen' UNION ALL
--       SELECT 'kilocode','<TOOLS_ROOT>/kilocode' UNION ALL
--       SELECT 'kudu','<TOOLS_ROOT>/kudu' UNION ALL
--       SELECT 'langextract','<TOOLS_ROOT>/langextract' UNION ALL
--       SELECT 'langflow','<TOOLS_ROOT>/langflow' UNION ALL
--       SELECT 'lecca-io','<TOOLS_ROOT>/lecca-io' UNION ALL
--       SELECT 'lumiere','<TOOLS_ROOT>/lumiere' UNION ALL
--       SELECT 'maigret','<TOOLS_ROOT>/maigret' UNION ALL
--       SELECT 'marotte','<TOOLS_ROOT>/marotte' UNION ALL
--       SELECT 'mcp-cli','<TOOLS_ROOT>/mcp-cli' UNION ALL
--       SELECT 'n8n','<TOOLS_ROOT>/n8n' UNION ALL
--       SELECT 'n8n-bot','<TOOLS_ROOT>/n8n-bot' UNION ALL
--       SELECT 'nim-router-mcp','<TOOLS_ROOT>/nim-router-mcp' UNION ALL
--       SELECT 'open-webui','<TOOLS_ROOT>/open-webui' UNION ALL
--       SELECT 'openapi-servers','<TOOLS_ROOT>/openapi-servers' UNION ALL
--       SELECT 'opencli-cookies','<TOOLS_ROOT>/opencli-cookies' UNION ALL
--       SELECT 'opencode-supermemory','<TOOLS_ROOT>/opencode-supermemory' UNION ALL
--       SELECT 'openrouter-cli','<TOOLS_ROOT>/openrouter-cli' UNION ALL
--       SELECT 'ouroboros-desktop','<TOOLS_ROOT>/ouroboros-desktop' UNION ALL
--       SELECT 'pangolin','<TOOLS_ROOT>/pangolin' UNION ALL
--       SELECT 'pheromone','<TOOLS_ROOT>/pheromone' UNION ALL
--       SELECT 'projet_roblox','<TOOLS_ROOT>/projet_roblox' UNION ALL
--       SELECT 'projetquizz','<TOOLS_ROOT>/projetquizz' UNION ALL
--       SELECT 'pydantic-ai','<TOOLS_ROOT>/pydantic-ai' UNION ALL
--       SELECT 'react-flow-manager','<TOOLS_ROOT>/react-flow-manager' UNION ALL
--       SELECT 'react-flow-sys','<TOOLS_ROOT>/react-flow-sys' UNION ALL
--       SELECT 'reaper','<TOOLS_ROOT>/reaper' UNION ALL
--       SELECT 'rokit','<TOOLS_ROOT>/rokit' UNION ALL
--       SELECT 'role agent convertion','<TOOLS_ROOT>/role agent convertion' UNION ALL
--       SELECT 'rovodev-new','<TOOLS_ROOT>/rovodev-new' UNION ALL
--       SELECT 'rowboat','<TOOLS_ROOT>/rowboat' UNION ALL
--       SELECT 'scanopy','<TOOLS_ROOT>/scanopy' UNION ALL
--       SELECT 'scraperai','<TOOLS_ROOT>/scraperai' UNION ALL
--       SELECT 'security_sheeld','<TOOLS_ROOT>/security_sheeld' UNION ALL
--       SELECT 'self-hosted-ai-starter-kit','<TOOLS_ROOT>/self-hosted-ai-starter-kit' UNION ALL
--       SELECT 'servers','<TOOLS_ROOT>/servers' UNION ALL
--       SELECT 'sim','<TOOLS_ROOT>/sim' UNION ALL
--       SELECT 'systeme_hydroponique_6','<TOOLS_ROOT>/systeme_hydroponique_6' UNION ALL
--       SELECT 'td','<TOOLS_ROOT>/td' UNION ALL
--       SELECT 'telegram_bot','<TOOLS_ROOT>/telegram_bot' UNION ALL
--       SELECT 'terra-def-save','<TOOLS_ROOT>/terra-def-save' UNION ALL
--       SELECT 'test-hermès-injection','<TOOLS_ROOT>/test-hermès-injection' UNION ALL
--       SELECT 'teste-orchestrator-server','<TOOLS_ROOT>/teste-orchestrator-server' UNION ALL
--       SELECT 'teste-orchestrator-server-windsurf-roocode','<TOOLS_ROOT>/teste-orchestrator-server-windsurf-roocode' UNION ALL
--       SELECT 'the-scrib','<TOOLS_ROOT>/the-scrib' UNION ALL
--       SELECT 'ue5-mcp','<TOOLS_ROOT>/ue5-mcp' UNION ALL
--       SELECT 'vibe-rules-collection','<TOOLS_ROOT>/vibe-rules-collection' UNION ALL
--       SELECT 'vtracer','<TOOLS_ROOT>/vtracer' UNION ALL
--       SELECT 'windsurf-antigravity-rules','<TOOLS_ROOT>/windsurf-antigravity-rules' UNION ALL
--       SELECT 'wisprflowpy','<TOOLS_ROOT>/wisprflowpy' UNION ALL
--       SELECT 'wisprflowpy_old','<TOOLS_ROOT>/wisprflowpy_old' UNION ALL
--       SELECT 'wokwi-pro-extension','<TOOLS_ROOT>/wokwi-pro-extension' UNION ALL
--       SELECT 'workfloows-tutorials-main','<TOOLS_ROOT>/workfloows-tutorials-main' UNION ALL
--       SELECT 'workspace-creator','<TOOLS_ROOT>/workspace-creator' UNION ALL
--       SELECT 'xyflow','<TOOLS_ROOT>/xyflow' UNION ALL
--       SELECT 'zvec','<TOOLS_ROOT>/zvec'
-- ) AS m
-- WHERE p.name = m.name
--   AND (p.root_path IS NULL OR p.root_path <> m.root_path);
--
-- Non résolus sur disque (11) — compléter manuellement si pertinent :
--   'tools-local'  → '<TOOLS_ROOT>'  (la racine elle-même)
--   'DafnckMachine-v3.1-main'  'Gradient tracer'  'Nouveau dossier'
--   'Nouveau dossier (2)'  'Nweton'  'Safran_Box-copie'  'autotrace'
--   'headroom'  'safran-site_perso'  'teste injection'
--   (certains vivent peut-être hors de <TOOLS_ROOT>)
--
-- Équivalent portable sans UPDATE..FROM (SQLite < 3.33) :
--   UPDATE projects SET root_path = (
--     SELECT m.column2 FROM (VALUES ('432z','F:/...'),...) AS m
--     WHERE m.column1 = projects.name)
--   WHERE name IN (SELECT column1 FROM (VALUES ('432z','F:/...'),...));
--   (dans un VALUES nu, les colonnes s'appellent column1, column2...)


-- ============================================================================
-- F. MAINTENANCE POST-INDEX — commenté (verrou écriture bref en WAL)
-- ============================================================================
-- À exécuter une fois après création des index pour alimenter sqlite_stat1 :
-- ANALYZE;
-- Variante moins intrusive : PRAGMA optimize;
