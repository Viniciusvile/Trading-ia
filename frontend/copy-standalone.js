const fs = require('fs');
const path = require('path');

const srcPublic = path.join(__dirname, 'public');
const destPublic = path.join(__dirname, '.next', 'standalone', 'public');

const srcStatic = path.join(__dirname, '.next', 'static');
const destStatic = path.join(__dirname, '.next', 'standalone', '.next', 'static');

try {
  if (fs.existsSync(srcPublic)) {
    fs.cpSync(srcPublic, destPublic, { recursive: true, force: true });
    console.log('Successfully copied public folder to standalone');
  } else {
    console.log('No public folder found to copy');
  }

  if (fs.existsSync(srcStatic)) {
    fs.cpSync(srcStatic, destStatic, { recursive: true, force: true });
    console.log('Successfully copied .next/static folder to standalone');
  } else {
    console.log('No .next/static folder found to copy');
  }
} catch (err) {
  console.error('Error copying standalone assets:', err);
  process.exit(1);
}
