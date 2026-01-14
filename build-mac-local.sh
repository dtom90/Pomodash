#!/bin/bash

# Script to run the CircleCI build-mac job locally
# This replicates the steps from .circleci/config.yml build-mac job

set -e  # Exit on error

# Load environment variables from .env file if it exists
if [ -f .env ]; then
    echo "📄 Loading environment variables from .env file..."
    set -a  # Automatically export all variables
    source .env
    set +a  # Stop automatically exporting
fi

echo "🚀 Starting local macOS build process..."

# Step 1: Install/Setup NVM (if not already installed)
echo "📦 Setting up NVM..."
if [ ! -d "$HOME/.nvm" ]; then
    echo "Installing NVM..."
    wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Step 2: Install Node v22.15.0
echo "📦 Installing Node v22.15.0..."
nvm install v22.15.0
nvm use v22.15.0
nvm alias default v22.15.0

# Verify Node version
echo "✅ Node version: $(node --version)"
echo "✅ npm version: $(npm --version)"

# Step 3: Install Python setuptools (if needed)
echo "📦 Installing Python setuptools..."
if command -v pip3 &> /dev/null; then
    pip3 install setuptools
elif command -v pip &> /dev/null; then
    pip install setuptools
else
    echo "⚠️  Warning: pip not found. Skipping setuptools installation."
fi

# Step 4: Install npm dependencies
echo "📦 Installing npm dependencies..."
npm install

# Step 5: Reset xcode selection (optional, but matches CI)
echo "🔧 Resetting xcode-select..."
sudo xcode-select -r

# Step 6: Bump version
echo "📈 Bumping version..."
# Allow version type to be specified (patch, minor, major), default to patch
VERSION_TYPE=${1:-patch}
npm version "$VERSION_TYPE" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "✅ Version bumped to: $NEW_VERSION"

# Step 7: Create GitHub release
echo "📤 Creating GitHub release..."

# Check if GitHub CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ Error: GitHub CLI (gh) is not installed!"
    echo "   Please install it using: brew install gh"
    echo "   Or visit: https://cli.github.com/"
    exit 1
fi

# Check for GitHub token
if [ -z "$GH_TOKEN" ] && [ -z "$GITHUB_TOKEN" ]; then
    echo "❌ Error: GitHub token not found!"
    echo "   Please set GH_TOKEN or GITHUB_TOKEN in one of these ways:"
    echo "   1. Create a .env file in the project root with: GH_TOKEN=your_token_here"
    echo "   2. Export as environment variable: export GH_TOKEN=your_token_here"
    echo "   You can create a token at: https://github.com/settings/tokens"
    echo "   Required permissions: Contents (Read and write), Metadata (Read)"
    exit 1
fi

# Set up GitHub CLI token
export GH_TOKEN=${GH_TOKEN:-$GITHUB_TOKEN}

# Check if a release with this version already exists
if gh release view "v$NEW_VERSION" &> /dev/null; then
    echo "❌ Release v$NEW_VERSION already exists. Skipping release creation."
    exit 1
fi

# Get the latest commit message
COMMIT_MSG=$(git log -1 --pretty=%B)

# Create a draft release using gh cli
echo "Creating new release v$NEW_VERSION"
gh release create "v$NEW_VERSION" \
  --draft \
  --title "$NEW_VERSION" \
  --notes "## What's Changed

$COMMIT_MSG"

# Step 8: Build macOS app and publish to GitHub Releases
echo "🔨 Building macOS app and publishing to GitHub Releases..."
GH_TOKEN=$GH_TOKEN npm run electron:build -- --publish always

echo "✅ Build complete! Check https://github.com/dtom90/PomoTrack/releases"
