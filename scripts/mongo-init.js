/* global db, print */
// MongoDB initialization script
// This runs when the MongoDB container starts for the first time

// Switch to the application database
// eslint-disable-next-line no-global-assign
db = db.getSiblingDB('bsv_tracker');

// Create a user for the application
db.createUser({
  user: 'bsv_tracker_user',
  pwd: 'bsv_tracker_password',
  roles: [
    {
      role: 'readWrite',
      db: 'bsv_tracker'
    }
  ]
});

// Create collections (optional, they'll be created automatically)
db.createCollection('blocks');
db.createCollection('deposit_addresses');
db.createCollection('active_transactions');
db.createCollection('archived_transactions');

print('MongoDB initialization completed for bsv_tracker database');
