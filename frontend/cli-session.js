/* Independent native-session document format. Loading never executes code. */
'use strict';
const NativeSession = (() => {
  const format = 'gauss-o-matic-root-cli';
  function read(value) {
    if (!value || value.format !== format || value.version !== 1) throw new Error('Open a native ROOT session saved by this interface, or a C++ text file. Classic and Modern documents use a different format.');
    if (!Array.isArray(value.commands) || !Array.isArray(value.canvases) || typeof value.input !== 'string') throw new Error('This session file is missing its input, command history, or canvas snapshots.');
    if (value.commands.some(c=>!c || typeof c.code !== 'string' || typeof c.output !== 'string')) throw new Error('This session file contains an unreadable command entry.');
    if (value.canvases.some(c=>!c || typeof c.name !== 'string' || !c.json || c.json._typename !== 'TCanvas')) throw new Error('This session file contains an unreadable canvas snapshot.');
    return {input:value.input, commands:value.commands.map(c=>({code:c.code,output:c.output,ok:c.ok !== false})),canvases:value.canvases.map(c=>({name:c.name,title:String(c.title || ''),json:c.json}))};
  }
  function write(input, commands, canvases) {
    return {format,version:1,saved:new Date().toISOString(),input,commands,canvases};
  }
  return {read,write};
})();
if (typeof module !== 'undefined') module.exports = NativeSession;
