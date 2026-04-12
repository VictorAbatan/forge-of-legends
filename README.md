# Inkcraft RP

## Folder Structure
```
inkcraft-rp/
├── index.html              ← Animated landing page (entry point)
├── assets/                 ← Images, icons, map files
├── css/
│   ├── global.css          ← Variables, reset, shared styles
│   ├── auth.css            ← Login/signup styles
│   ├── create-character.css
│   └── dashboard.css
├── firebase/
│   └── firebase.js         ← Firebase init & exports
├── js/
│   ├── auth.js
│   ├── character.js
│   └── dashboard.js
└── html/
    ├── auth.html           ← Login + Signup (tabbed, side by side)
    ├── create-character.html
    └── dashboard.html
```

## Page Flow
index.html → html/auth.html → html/create-character.html → html/dashboard.html

## How to Run
Open with VS Code Live Server. Right-click index.html → Open with Live Server.

## Deity Invite Codes
Default: INKCRAFT-DEITY-001 / INKCRAFT-DEITY-002
(Change these in html/auth.html → DEITY_CODES array)
