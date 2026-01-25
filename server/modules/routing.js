const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const loadConfig = require('../handlers/config.js');
const settings = loadConfig('./config.toml');

const HeliactylModule = {
  "name": "Routing",
  "version": "1.0.0",
  "api_level": 4,
  "target_platform": "10.0.0",
  "description": "Core module",
  "author": {
    "name": "Matt James",
    "email": "me@ether.pizza",
    "url": "https://ether.pizza"
  },
  "dependencies": [],
  "permissions": [],
  "routes": [],
  "config": {},
  "hooks": [],
  "tags": ['core'],
  "license": "MIT"
};

module.exports.HeliactylModule = HeliactylModule;
module.exports.load = async function (app, db) {
  const distPath = path.join(__dirname, '../../frontend/dist');

  app.use('/', express.static(distPath, {
    fallthrough: true,
    index: false
  }));

  app.get('/*', async (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();

    try {
      const indexPath = path.join(distPath, 'index.html');
      let html = await fs.readFile(indexPath, 'utf8');

      // Inject dynamic values
      html = html.replace(/{{SITE_NAME}}/g, settings.website.name || "Heliactyl");

      res.send(html);
    } catch (err) {
      // If dist/index.html doesn't exist, try frontend/index.html (dev mode)
      try {
        const devIndexPath = path.join(__dirname, '../../frontend/index.html');
        let html = await fs.readFile(devIndexPath, 'utf8');
        html = html.replace(/{{SITE_NAME}}/g, settings.website.name || "Heliactyl");
        res.send(html);
      } catch (devErr) {
        next();
      }
    }
  });
};