import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// A link for another device carries its access token. The server has set a cookie by now, so the address drops it.
if (new URLSearchParams(location.search).has('token')) history.replaceState(null, '', location.pathname);
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
