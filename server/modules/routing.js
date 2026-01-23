const express = require('express');
const path = require('path');

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
module.exports.load = async function(app, db) {
  const distPath = path.join(__dirname, '../../frontend/dist');

  app.use('/', express.static(distPath, {
    fallthrough: true,
    index: false
  }));

  app.get('/*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
};