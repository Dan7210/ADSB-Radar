import {
    BrowserRouter as Router,
    Routes,
    Route,
} from "react-router-dom";
import MapApp from "./MapApp";
import YJFCMap from "./YJFCMap";


function App() {
    return (
        <Router>
            <Routes>
                <Route path="/ADSB-Radar" element={<MapApp />} />
                <Route path="/ADSB-Radar/YJFC" element={<YJFCMap />} />
            </Routes>
        </Router>
    );
}

export default App
