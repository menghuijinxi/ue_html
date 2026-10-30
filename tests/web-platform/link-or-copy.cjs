const fs = require('node:fs');

function linkOrCopy(source, destination) {
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
  }
}

module.exports = {linkOrCopy};
