'use strict';
/**
 * local-paths.js — chemins propres à la machine, JAMAIS commités.
 *
 * `.agent/agent-bridge/local-paths.json` est gitignoré : il contient les
 * chemins absolus de ce poste (binaires, vault, racines de projets). Le repo
 * ne transporte que les clés ; chaque machine fournit ses valeurs.
 *
 * Clés utilisées :
 *   nodeExe          ex. "<nvm-dir>\\nodejs\\node.exe"
 *   kitRoot          ex. "<kit-root>"
 *   cliAnythingRoot  ex. "<projets>\\CLI-Anything"
 *   serversRoot      ex. "<servers>"
 *   obsidianVault    ex. "<vault>\\Doc"
 *   cerberosAcpBin   ex. "<cliAnythingRoot>\\cerberos\\agent-harness\\bin\\cerberos-acp.js"
 *   cerberosD2r2Bin  ex. "<cliAnythingRoot>\\cerberos\\agent-harness\\bin\\d2r2-acp.js"
 */
const fs = require('fs');
const path = require('path');

let cache;
function localPath(key) {
    if (cache === undefined) {
        try { cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'local-paths.json'), 'utf8')); }
        catch { cache = null; }
    }
    return cache ? (cache[key] || null) : null;
}

module.exports = { localPath };
