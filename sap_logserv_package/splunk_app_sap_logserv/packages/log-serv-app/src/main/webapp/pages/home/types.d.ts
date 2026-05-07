// Module declarations for @splunk/* packages that don't ship their own types.
// Loose typing — lets the rest of the app compile while we treat these as
// untyped third-party libs at the boundary. Tighten as we use them.

declare module '@splunk/search-job';
declare module '@splunk/react-page/18';
