const path = require('path');
const fs = require('fs');

const DATABASE_URL = process.env.DATABASE_URL;

if (DATABASE_URL) {
  console.log('Using PostgreSQL database');
  module.exports = require('./db-pg');
} else {
  console.log('Using SQLite database');
  module.exports = require('./db-sqlite');
}
