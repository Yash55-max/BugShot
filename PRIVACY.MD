# Privacy Policy for BugShot

**Last Updated: May 14, 2026**

BugShot is committed to protecting your privacy. This Privacy Policy explains how we handle your data when you use the BugShot browser extension.

## 1. Data Collection and Usage

BugShot is designed to help you capture and report bugs directly to GitHub. To do this effectively, the extension collects and processes the following types of information:

*   **Environment Metadata**: When you prepare a bug report, the extension automatically collects technical details about your environment, including:
    *   Current URL and Page Title
    *   Browser version
    *   Operating System (OS)
    *   Screen resolution and viewport size
    *   Timestamp
*   **Interaction Logs**: The extension records the last 20 user interactions (such as clicks and element descriptions) to help you generate "Steps to Reproduce" automatically.
*   **Screenshots**: The extension captures images of your current browser tab (viewport or full-page) when you initiate a capture. These images are processed locally on your machine for annotation and cropping.
*   **Technical Logs**: If you use the DevTools panel, the extension captures console errors and network failure logs from the active tab.

## 2. Data Storage

BugShot prioritizes local storage to ensure your sensitive information remains under your control:

*   **GitHub Credentials**: Your GitHub Personal Access Token, repository owner name, and repository name are stored locally in your browser's secure `chrome.storage.local` area.
*   **Session Data**: In-memory logs and interaction data are cleared when the extension or browser session ends.

**We do not host any backend servers.** Your data is never stored on our infrastructure because it doesn't exist.

## 3. Data Transmission

BugShot only transmits data to third parties when you explicitly trigger an action:

*   **GitHub API**: When you click "Submit Issue," the extension sends your bug report (including screenshots, metadata, and logs) directly to the GitHub repository you have configured using the official GitHub REST API.
*   **No Other Third Parties**: BugShot does not send your data to any other third-party services, analytics providers, or advertising networks.

## 4. User Control

*   **Explicit Submission**: No data is ever sent to GitHub without your explicit action.
*   **Data Deletion**: You can clear your stored settings (including your GitHub Token) at any time by clicking the "Clear All Data" or "Logout" button within the extension settings.
*   **Permissions**: The extension only requests the permissions necessary to function (e.g., `activeTab` for screenshots, `storage` for settings).

## 5. Security

We use the official GitHub API and follow secure coding practices to ensure your data is handled safely. Since your GitHub Token is stored locally, it is as secure as your browser profile. We recommend using a token with the minimum required scopes (`repo` only).

## 6. Changes to This Policy

We may update this Privacy Policy from time to time. Any changes will be reflected by the "Last Updated" date at the top of this page.

## 7. Contact Us

If you have any questions about this Privacy Policy, please open an issue on our [GitHub Repository](https://github.com/Yash55-max/BugShot/issues).
