import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import DisableZoom from './DisableZoom.jsx';

createRoot(document.getElementById('root')).render(
  <>
    <DisableZoom />
    <App />
  </>
);