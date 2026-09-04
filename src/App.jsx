import {
    HashRouter as Router,
    Routes,
    Route,
} from "react-router-dom";
import MapApp from "./MapApp";
import YJFCMap from "./YJFCMap";

function App() {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<MapApp />} />
                <Route path="/YJFC" element={<YJFCMap />} />
            </Routes>
        </Router>
    );
}

export default App;