#!/bin/bash

# Install PM2 globally if not already installed
# if ! command -v pm2 &> /dev/null; then
#     echo "Installing PM2..."
#     yarn global add pm2
# fi

# Install dependencies
# echo "Installing dependencies..."
# yarn install

# # Build the application
# echo "Building the application..."
# yarn build

# Remove existing PM2 process if it exists
echo "Removing existing PM2 process..."
pm2 delete aams-app || true

# Start the application with PM2
echo "Starting the application with PM2..."
pm2 start yarn --name "aams-app" -- dev

# Display PM2 status
pm2 status

# Save PM2 configuration
pm2 save

# Setup PM2 startup
sudo pm2 startup

echo "Application has been started with PM2!"

