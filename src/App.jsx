import {
    HashRouter as Router,
    Routes,
    Route,
} from "react-router-dom";
import MapApp from "./MapApp";
import YJFCMap from "./YJFCMap";
import YJFCDestinations from "./YJFCDestinations";

function App() {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<MapApp />} />
                <Route path="/YJFC" element={<YJFCMap />} />
                <Route path="/yjfc-destinations" element={<YJFCDestinations />} />
            </Routes>
        </Router>
    );
}

export default App;
