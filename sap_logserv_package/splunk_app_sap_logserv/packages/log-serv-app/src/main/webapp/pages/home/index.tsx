import React from 'react';
import layout from '@splunk/react-page/18';
import App from './App';

// Force Splunk's Prisma Dark theme regardless of the user's per-account
// preference. This gives the LogServ app a consistent dark visual identity
// matching the existing v0.0.4.2 dashboards.
layout(<App />, {
    theme: 'dark',
    themeFamily: 'prisma',
    themeDensity: 'compact',
});
