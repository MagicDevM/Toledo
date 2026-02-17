/**
 *  Heliactyl Next database handler
 */

/**
 * @module HeliactylNextDB
 * @version 0.5.0
 * @description Multi-database adapter for Heliactyl Next - Supports SQLite and PostgreSQL (CockroachDB compatible)
 */

const path = require('path');
const winston = require('winston');
const LRU = require('lru-cache');

// Configure Winston logger
const dbLogger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/db.log' })
  ]
});

/**
 * @class HeliactylDB
 * @description Main database class that handles all database operations with queuing and TTL support
 * @supports SQLite, PostgreSQL, CockroachDB
 */
class HeliactylDB {
  /**
   * @constructor
   * @param {string} dbPath - Database connection string (sqlite://path or postgresql://user:pass@host/db)
   * @throws {Error} If database path is not provided or connection fails... 
   */
  constructor(dbPath) {
    if (!dbPath) {
      throw new Error('Database path is required');
    }

    // Handle both string and object configs
    if (typeof dbPath === 'object' && dbPath.url) {
      this.dbPath = dbPath.url;
    } else if (typeof dbPath === 'string') {
      this.dbPath = dbPath;
    } else {
      throw new Error('Database path must be a string or an object with a url property');
    }

    this.isPostgres = this.dbPath.startsWith('postgresql://') || this.dbPath.startsWith('postgres://');
    this.isSQLite = this.dbPath.startsWith('sqlite://') || (!this.isPostgres && !this.dbPath.includes('://'));

    if (this.isSQLite) {
      this.initSQLite();
    } else if (this.isPostgres) {
      this.initPostgreSQL();
    } else {
      throw new Error(`Unsupported database type: ${dbPath}. Use sqlite:// or postgresql://`);
    }

    this.namespace = 'heliactyl';
    this.ttlSupport = false;
    this.queue = [];
    this.isProcessing = false;
    this.processingLock = false; // Lock to prevent race conditions
    this.totalOperationTime = 0;
    this.operationCount = 0;
    this.maxQueueSize = 10000; // Prevent unbounded queue growth
    this.tableName = 'heliactyl'; // Default table name

    // Initialize LRU cache for hot data
    this.cache = new LRU({
      max: 500, // Max 500 items
      ttl: 1000 * 60 * 5, // 5 minutes default TTL
      updateAgeOnGet: true,
      updateAgeOnHas: true
    });

    // Initialize the database table
    this.initializeDatabase().catch(err => {
      console.error('Failed to initialize database:', err);
    });

    // Log queue stats every 5 seconds
    setInterval(() => this.logQueueStats(), 5000);

    // Cleanup expired entries periodically if TTL is supported
    if (this.ttlSupport) {
      setInterval(() => this.cleanupExpired(), 60000);
    }
  }

  /**
   * Initialize SQLite connection
   * @private
   */
  initSQLite() {
    const sqlite3 = require('sqlite3').verbose();
    const resolvedPath = path.resolve(this.dbPath.replace('sqlite://', ''));
    this.db = new sqlite3.Database(resolvedPath, (err) => {
      if (err) {
        throw new Error(`Failed to connect to SQLite database: ${err.message}`);
      }
    });
    this.dbType = 'sqlite';
    // Enable WAL mode for better concurrency
    this.db.run('PRAGMA journal_mode = WAL');
  }

  /**
   * Initialize PostgreSQL/CockroachDB connection
   * @private
   */
  initPostgreSQL() {
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString: this.dbPath,
      max: 20, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    this.dbType = 'postgresql';
    
    // Test connection
    this.pool.query('SELECT NOW()', (err) => {
      if (err) {
        console.error('Failed to connect to PostgreSQL database:', err.message);
      } else {
        console.log('Connected to PostgreSQL/CockroachDB');
      }
    });
  }

  /**
   * @async
   * @method initializeDatabase
   * @description Initializes database tables and indexes
   * @returns {Promise<void>}
   */
  async initializeDatabase() {
    if (this.dbType === 'sqlite') {
      return this.initializeSQLite();
    } else {
      return this.initializePostgreSQL();
    }
  }

  /**
   * Initialize SQLite database
   * @private
   */
  async initializeSQLite() {
    return this.executeQuery(() => new Promise((resolve, reject) => {
      // First check if keyv table exists
      this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='keyv'", (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (row) {
          console.log('Using Heliactyl Next Legacy compatibility mode - Found existing keyv database');
          this.tableName = 'keyv';
          this.namespace = 'keyv';
          resolve();
          return;
        }

        // Create Heliactyl Next table if keyv doesn't exist
        const createTableSQL = `
          CREATE TABLE IF NOT EXISTS heliactyl (
            [key] TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
          )`;

        this.db.serialize(() => {
          this.db.run('BEGIN TRANSACTION');
          this.db.run(createTableSQL, (err) => {
            if (err) {
              this.db.run('ROLLBACK');
              reject(err);
              return;
            }

            this.db.run('CREATE INDEX IF NOT EXISTS idx_heliactyl_key ON heliactyl ([key])', (indexErr) => {
              if (indexErr) {
                this.db.run('ROLLBACK');
                reject(indexErr);
                return;
              }

              this.db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  reject(commitErr);
                } else {
                  resolve();
                }
              });
            });
          });
        });
      });
    }));
  }

  /**
   * Initialize PostgreSQL/CockroachDB database
   * @private
   */
  async initializePostgreSQL() {
    try {
      // Check if keyv table exists
      const keyvCheck = await this.pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'keyv'"
      );
      
      if (keyvCheck.rows.length > 0) {
        console.log('Using Heliactyl Next Legacy compatibility mode - Found existing keyv database');
        this.tableName = 'keyv';
        this.namespace = 'keyv';
        return;
      }

      // Create table for PostgreSQL/CockroachDB
      const createTableSQL = `
        CREATE TABLE IF NOT EXISTS heliactyl (
          key VARCHAR(255) PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER DEFAULT (EXTRACT(EPOCH FROM NOW()))
        )`;
      
      await this.pool.query(createTableSQL);
      
      // Create index
      await this.pool.query('CREATE INDEX IF NOT EXISTS idx_heliactyl_key ON heliactyl (key)');
      
      console.log('PostgreSQL/CockroachDB table initialized successfully');
    } catch (err) {
      console.error('Failed to initialize PostgreSQL database:', err);
      throw err;
    }
  }

  /**
   * @async
   * @method executeQuery
   * @description Executes a database operation with queuing and timeout
   * @param {Function} operation - Database operation to execute
   * @returns {Promise<any>} Result of the operation
   * @throws {Error} If queue is full or operation times out
   */
  async executeQuery(operation) {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error('Database queue is full');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Database operation timed out'));
      }, 30000); // 30 second timeout

      this.queue.push({
        operation,
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  /**
   * @async
   * @method processQueue
   * @description Processes the next operation in the queue
   * @private
   */
  async processQueue() {
    // Use a lock to prevent race conditions
    if (this.processingLock || this.queue.length === 0) return;
    
    this.processingLock = true;
    this.isProcessing = true;
    
    const { operation, resolve, reject } = this.queue.shift();
    const startTime = Date.now();

    try {
      const result = await operation();
      const operationTime = Date.now() - startTime;
      this.updateStats(operationTime);

      // Log successful transaction
      dbLogger.info('Database transaction completed', {
        operationTime,
        queueLength: this.queue.length
      });

      resolve(result);
    } catch (error) {
      // Log failed transaction
      dbLogger.error('Database transaction failed', {
        error: error.message,
        queueLength: this.queue.length
      });

      console.error('Database operation failed:', error);
      reject(error);
    } finally {
      this.isProcessing = false;
      this.processingLock = false;
      
      // Process next item if queue not empty
      if (this.queue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  /**
   * @method updateStats
   * @description Updates operation statistics
   * @param {number} operationTime - Time taken for operation in milliseconds
   * @private
   */
  updateStats(operationTime) {
    this.totalOperationTime += operationTime;
    this.operationCount++;

    // Reset stats periodically to prevent overflow
    if (this.operationCount > 1000000) {
      this.totalOperationTime = operationTime;
      this.operationCount = 1;
    }
  }

  /**
   * @method logQueueStats
   * @description Logs queue statistics
   * @private
   */
  logQueueStats() {
    const avgOperationTime = this.operationCount > 0 ? this.totalOperationTime / this.operationCount : 0;
    dbLogger.info('Queue statistics', {
      queueLength: this.queue.length,
      averageOperationTime: avgOperationTime.toFixed(2)
    });
  }

  /**
   * @async
   * @method cleanupExpired
   * @description Removes expired entries from database
   * @returns {Promise<void>}
   */
  async cleanupExpired() {
    if (!this.ttlSupport) return;

    if (this.dbType === 'sqlite') {
      return this.executeQuery(() => new Promise((resolve, reject) => {
        this.db.run(`DELETE FROM ${this.tableName} WHERE json_extract(value, "$.expires") < ?`, [Date.now()], (err) => {
          if (err) reject(err);
          else resolve();
        });
      }));
    } else {
      // PostgreSQL - Use regex to extract expires field from JSON
      try {
        await this.pool.query(
          `DELETE FROM ${this.tableName} WHERE (value::jsonb->>'expires')::bigint < $1`,
          [Date.now()]
        );
      } catch (err) {
        console.error('Failed to cleanup expired entries:', err);
      }
    }
  }

  /**
   * @async
   * @method get
   * @description Retrieves a value by key
   * @param {string} key - Key to retrieve
   * @returns {Promise<any>} Retrieved value
   * @throws {Error} If key is not provided or value parsing fails
   */
  async get(key) {
    if (!key) throw new Error('Key is required');

    const fullKey = `${this.namespace}:${key}`;

    if (this.dbType === 'sqlite') {
      return this.executeQuery(() => new Promise((resolve, reject) => {
        this.db.get(`SELECT value FROM ${this.tableName} WHERE key = ?`, [fullKey], (err, row) => {
          if (err) {
            reject(err);
          } else {
            if (row) {
              try {
                const parsed = JSON.parse(row.value);
                if (this.ttlSupport && parsed.expires && parsed.expires < Date.now()) {
                  this.delete(key).catch(console.error);
                  resolve(undefined);
                } else {
                  resolve(parsed.value);
                }
              } catch (e) {
                reject(new Error(`Failed to parse stored value: ${e.message}`));
              }
            } else {
              resolve(undefined);
            }
          }
        });
      }));
    } else {
      // PostgreSQL/CockroachDB
      try {
        const result = await this.pool.query(
          `SELECT value FROM ${this.tableName} WHERE key = $1`,
          [fullKey]
        );
        
        if (result.rows.length > 0) {
          const parsed = JSON.parse(result.rows[0].value);
          if (this.ttlSupport && parsed.expires && parsed.expires < Date.now()) {
            await this.delete(key);
            return undefined;
          } else {
            return parsed.value;
          }
        } else {
          return undefined;
        }
      } catch (err) {
        throw new Error(`Failed to get value: ${err.message}`);
      }
    }
  }

  /**
   * @async
   * @method set
   * @description Sets a value with optional TTL
   * @param {string} key - Key to set
   * @param {any} value - Value to store
   * @param {number} [ttl] - Time-to-live in milliseconds
   * @returns {Promise<void>}
   * @throws {Error} If key is not provided
   */
  async set(key, value, ttl) {
    if (!key) throw new Error('Key is required');

    const fullKey = `${this.namespace}:${key}`;
    const expires = this.ttlSupport && ttl ? Date.now() + ttl : undefined;
    const data = JSON.stringify({
      value,
      expires
    });

    if (this.dbType === 'sqlite') {
      return this.executeQuery(() => new Promise((resolve, reject) => {
        this.db.run(`INSERT OR REPLACE INTO ${this.tableName} (key, value) VALUES (?, ?)`, [fullKey, data], (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }));
    } else {
      // PostgreSQL/CockroachDB - UPSERT syntax
      try {
        await this.pool.query(
          `INSERT INTO ${this.tableName} (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [fullKey, data]
        );
      } catch (err) {
        throw new Error(`Failed to set value: ${err.message}`);
      }
    }
  }

  /**
   * @async
   * @method delete
   * @description Deletes a value by key
   * @param {string} key - Key to delete
   * @returns {Promise<void>}
   * @throws {Error} If key is not provided
   */
  async delete(key) {
    if (!key) throw new Error('Key is required');

    const fullKey = `${this.namespace}:${key}`;

    if (this.dbType === 'sqlite') {
      return this.executeQuery(() => new Promise((resolve, reject) => {
        this.db.run(`DELETE FROM ${this.tableName} WHERE key = ?`, [fullKey], (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }));
    } else {
      try {
        await this.pool.query(`DELETE FROM ${this.tableName} WHERE key = $1`, [fullKey]);
      } catch (err) {
        throw new Error(`Failed to delete value: ${err.message}`);
      }
    }
  }

  /**
   * @async
   * @method clear
   * @description Clears all values in the current namespace
   * @returns {Promise<void>}
   */
  async clear() {
    const pattern = `${this.namespace}:%`;

    if (this.dbType === 'sqlite') {
      return this.executeQuery(() => new Promise((resolve, reject) => {
        this.db.run(`DELETE FROM ${this.tableName} WHERE key LIKE ?`, [pattern], (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }));
    } else {
      try {
        await this.pool.query(`DELETE FROM ${this.tableName} WHERE key LIKE $1`, [pattern]);
      } catch (err) {
        throw new Error(`Failed to clear values: ${err.message}`);
      }
    }
  }

  /**
   * @async
   * @method has
   * @description Checks if a key exists
   * @param {string} key - Key to check
   * @returns {Promise<boolean>} True if key exists
   * @throws {Error} If key is not provided
   */
  async has(key) {
    if (!key) throw new Error('Key is required');

    const fullKey = `${this.namespace}:${key}`;

    if (this.dbType === 'sqlite') {
      return this.executeQuery(() => new Promise((resolve, reject) => {
        this.db.get(`SELECT 1 FROM ${this.tableName} WHERE key = ?`, [fullKey], (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(!!row);
          }
        });
      }));
    } else {
      try {
        const result = await this.pool.query(`SELECT 1 FROM ${this.tableName} WHERE key = $1`, [fullKey]);
        return result.rows.length > 0;
      } catch (err) {
        throw new Error(`Failed to check key: ${err.message}`);
      }
    }
  }

  /**
   * @async
   * @method close
   * @description Closes database connection
   * @returns {Promise<void>}
   */
  async close() {
    if (this.dbType === 'sqlite') {
      return new Promise((resolve, reject) => {
        this.db.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      await this.pool.end();
    }
  }

  /**
   * @async
   * @method getCached
   * @description Retrieves a value by key with caching
   * @param {string} key - Key to retrieve
   * @param {number} ttl - Cache TTL in milliseconds
   * @returns {Promise<any>} Retrieved value
   */
  async getCached(key, ttl = 300000) {
    const cacheKey = `${this.namespace}:${key}`;
    
    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    
    // Fetch from database
    const value = await this.get(key);
    
    // Store in cache if value exists
    if (value !== undefined && value !== null) {
      this.cache.set(cacheKey, value, { ttl });
    }
    
    return value;
  }

  /**
   * @async
   * @method setCached
   * @description Sets a value with cache invalidation
   * @param {string} key - Key to set
   * @param {any} value - Value to store
   * @param {number} ttl - Cache TTL in milliseconds
   * @returns {Promise<void>}
   */
  async setCached(key, value, ttl = 300000) {
    const cacheKey = `${this.namespace}:${key}`;
    
    // Update database
    await this.set(key, value);
    
    // Update cache
    this.cache.set(cacheKey, value, { ttl });
  }

  /**
   * @method clearCache
   * @description Clears cache for a specific key or pattern
   * @param {string} pattern - Key pattern to clear (supports * wildcard)
   * @returns {void}
   */
  clearCache(pattern) {
    if (pattern.includes('*')) {
      // Convert pattern to regex
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      for (const key of this.cache.keys()) {
        if (regex.test(key)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.delete(`${this.namespace}:${pattern}`);
    }
  }

  /**
   * @async
   * @method getAll
   * @description Retrieves all key-value pairs in the current namespace
   * @returns {Promise<Object>} Object containing all key-value pairs
   */
  async getAll() {
    const pattern = `${this.namespace}:%`;

    if (this.dbType === 'sqlite') {
      return this.executeQuery(() => new Promise((resolve, reject) => {
        this.db.all(`SELECT key, value FROM ${this.tableName} WHERE key LIKE ?`, [pattern], (err, rows) => {
          if (err) {
            reject(err);
          } else {
            const result = {};
            rows.forEach(row => {
              const key = row.key.replace(`${this.namespace}:`, '');
              try {
                const parsed = JSON.parse(row.value);
                if (!(this.ttlSupport && parsed.expires && parsed.expires < Date.now())) {
                  result[key] = parsed.value;
                }
              } catch (e) {
                console.error(`Failed to parse value for key ${key}:`, e);
              }
            });
            resolve(result);
          }
        });
      }));
    } else {
      try {
        const result = await this.pool.query(`SELECT key, value FROM ${this.tableName} WHERE key LIKE $1`, [pattern]);
        const output = {};
        result.rows.forEach(row => {
          const key = row.key.replace(`${this.namespace}:`, '');
          try {
            const parsed = JSON.parse(row.value);
            if (!(this.ttlSupport && parsed.expires && parsed.expires < Date.now())) {
              output[key] = parsed.value;
            }
          } catch (e) {
            console.error(`Failed to parse value for key ${key}:`, e);
          }
        });
        return output;
      } catch (err) {
        throw new Error(`Failed to get all values: ${err.message}`);
      }
    }
  }

  /**
   * @async
   * @method increment
   * @description Increments a numeric value by the specified amount
   * @param {string} key - Key to increment
   * @param {number} [amount=1] - Amount to increment by
   * @returns {Promise<number>} New value after increment
   */
  async increment(key, amount = 1) {
    const currentValue = await this.get(key) || 0;
    if (typeof currentValue !== 'number') {
      throw new Error('Value must be a number to increment');
    }
    const newValue = currentValue + amount;
    await this.set(key, newValue);
    return newValue;
  }

  /**
   * @async
   * @method decrement
   * @description Decrements a numeric value by the specified amount
   * @param {string} key - Key to decrement
   * @param {number} [amount=1] - Amount to decrement by
   * @returns {Promise<number>} New value after decrement
   */
  async decrement(key, amount = 1) {
    return this.increment(key, -amount);
  }

  /**
   * @async
   * @method search
   * @description Searches for keys matching a pattern
   * @param {string} pattern - Search pattern (SQL LIKE pattern)
   * @returns {Promise<string[]>} Array of matching keys
   */
  async search(pattern) {
    const fullPattern = `${this.namespace}:${pattern}`;

    if (this.dbType === 'sqlite') {
      return this.executeQuery(() => new Promise((resolve, reject) => {
        this.db.all(
          `SELECT key FROM ${this.tableName} WHERE key LIKE ?`,
          [fullPattern],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              resolve(rows.map(row => row.key.replace(`${this.namespace}:`, '')));
            }
          }
        );
      }));
    } else {
      try {
        const result = await this.pool.query(
          `SELECT key FROM ${this.tableName} WHERE key LIKE $1`,
          [fullPattern]
        );
        return result.rows.map(row => row.key.replace(`${this.namespace}:`, ''));
      } catch (err) {
        throw new Error(`Failed to search keys: ${err.message}`);
      }
    }
  }

  /**
   * @async
   * @method setMultiple
   * @description Sets multiple key-value pairs at once
   * @param {Object} entries - Object containing key-value pairs to set
   * @param {number} [ttl] - Optional TTL for all entries
   * @returns {Promise<void>}
   */
  async setMultiple(entries, ttl) {
    const entriesList = Object.entries(entries);
    
    if (this.dbType === 'sqlite') {
      return this.executeQuery(() => new Promise((resolve, reject) => {
        const stmt = this.db.prepare(`INSERT OR REPLACE INTO ${this.tableName} (key, value) VALUES (?, ?)`);

        this.db.serialize(() => {
          this.db.run('BEGIN TRANSACTION');

          try {
            for (const [key, value] of entriesList) {
              const data = JSON.stringify({
                value,
                expires: this.ttlSupport && ttl ? Date.now() + ttl : undefined
              });
              stmt.run(`${this.namespace}:${key}`, data);
            }

            this.db.run('COMMIT', (err) => {
              if (err) reject(err);
              else resolve();
            });
          } catch (err) {
            this.db.run('ROLLBACK');
            reject(err);
          } finally {
            stmt.finalize();
          }
        });
      }));
    } else {
      // PostgreSQL/CockroachDB - Use batch insert with ON CONFLICT
      try {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          
          for (const [key, value] of entriesList) {
            const fullKey = `${this.namespace}:${key}`;
            const data = JSON.stringify({
              value,
              expires: this.ttlSupport && ttl ? Date.now() + ttl : undefined
            });
            await client.query(
              `INSERT INTO ${this.tableName} (key, value) VALUES ($1, $2)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
              [fullKey, data]
            );
          }
          
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        throw new Error(`Failed to set multiple values: ${err.message}`);
      }
    }
  }
}

module.exports = HeliactylDB;