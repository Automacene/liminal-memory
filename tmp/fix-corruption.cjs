const fs = require('fs');
let f = fs.readFileSync('demo/ui/js/internal/app.js', 'utf8');

// The corruption is: `}**\r\n * Luminal Memory...` 
// which should be: `}\n      }\n\n\n      var response;\n...`
// The `}**` needs to become `}` (closing messages[0] assignment)
// Then we need `\n      }\n` (closing the if block)
// Then the file continues normally from the SECOND copy

// Find the corruption point
const corruptIdx = f.indexOf('}**');
if (corruptIdx === -1) { console.log('No corruption found'); process.exit(1); }

// Everything before the corruption is good (the new messages[0] block)
const goodPart = f.slice(0, corruptIdx);

// After the corruption, the file has a duplicate starting with the file header comment.
// We need to find where the ORIGINAL continuation was - which is `}\n` (closing if block) + rest of handleSend
// In the second copy, find where `var response;` appears (that's what should follow after closing the if block)
const secondCopy = f.slice(corruptIdx + 3); // skip `}**`
const varResponseIdx = secondCopy.indexOf('var response;');
if (varResponseIdx === -1) { console.log('Cannot find var response;'); process.exit(1); }

// Back up to find the proper start point - should be preceded by whitespace/newlines
// We want to keep: `}\n\n\n      var response;` and everything after
// Find the `if (llmAvailable)` that contains var response
const restFromVarResponse = secondCopy.slice(varResponseIdx);

// Reconstruct: good part + close the messages assignment + close the if(llmTools) block + rest
const fixed = goodPart + '}\n      }\n\n      ' + restFromVarResponse;

fs.writeFileSync('demo/ui/js/internal/app.js', fixed);
console.log('Fixed! New length:', fixed.length);
