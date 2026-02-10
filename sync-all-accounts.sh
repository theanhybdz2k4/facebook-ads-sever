#!/bin/bash

# Sync all Facebook ad accounts
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxuY2dtYXh0cWpmYmN5cG5jZm9lIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzM0NzQxMywiZXhwIjoyMDgyOTIzNDEzfQ.zalV6mnyd1Iit0KbHnqLxemnBKFPbKz2159tkHtodJY"
BASE_URL="https://lncgmaxtqjfbcypncfoe.supabase.co/functions/v1"

# List of all account IDs to sync (from database query)
ACCOUNTS=(40 41 42 43 44 45 46 47 48)

echo "Starting sync for ${#ACCOUNTS[@]} accounts..."
echo ""

for ACCOUNT_ID in "${ACCOUNTS[@]}"; do
  echo "Syncing account $ACCOUNT_ID..."
  curl -X POST "$BASE_URL/ads/sync/account/$ACCOUNT_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json"
  echo ""
  echo "---"
  sleep 2  # Wait 2 seconds between syncs to avoid rate limits
done

echo ""
echo "All accounts synced!"
