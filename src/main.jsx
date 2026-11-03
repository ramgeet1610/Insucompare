import React from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import FEHBComparison from './FEHBComparison.jsx';

// Vercel Web Analytics: aggregate page counts only. It sets no cookie and never
// receives anything typed into the comparison tool - the ZIP code, medications,
// enrollment type and results stay in the browser. Disclosed in the privacy
// policy under "What we collect"; if this is ever removed, update that too.
createRoot(document.getElementById('root')).render(
  <>
    <FEHBComparison />
    <Analytics />
  </>
);
