const fetch = require("node-fetch");
global.fetch = fetch;
const { loadTiddler } = require('../plugins/neumark/firestore-syncadaptor-client/core.js');
const host=process.argv[2];
// TODO: this is hardcoded for now
const wiki = 'pn-wiki'
const token=process.argv[3];
loadTiddler({host, wiki}, TOKEN).then(tiddlers => console.log(JSON.stringify(tiddlers, null, 4)));
