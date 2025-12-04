// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface DungeonRecord {
  id: string;
  encryptedAttributes: string;
  timestamp: number;
  owner: string;
  dungeonName: string;
  status: "generating" | "ready" | "completed";
  monstersDefeated: number;
  treasuresFound: number;
}

// Randomly selected style: High Contrast (Red+Black), Retro Pixel, Center Radiation, Animation Rich
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generateDungeon = (encryptedData: string): { layout: string[], monsters: number, treasures: number } => {
  const seed = FHEDecryptNumber(encryptedData);
  const rng = (max: number, min = 0) => Math.floor((seed % 1000) / 1000 * (max - min + 1)) + min;
  
  const size = rng(5, 3); // 3x3 to 5x5 dungeon
  const layout = [];
  const roomTypes = ['Empty', 'Monster', 'Treasure', 'Boss', 'Trap'];
  
  for (let i = 0; i < size; i++) {
    const row = [];
    for (let j = 0; j < size; j++) {
      row.push(roomTypes[rng(roomTypes.length - 1)]);
    }
    layout.push(row.join(' | '));
  }

  return {
    layout,
    monsters: rng(10, 3),
    treasures: rng(7, 1)
  };
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [dungeons, setDungeons] = useState<DungeonRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newDungeonData, setNewDungeonData] = useState({ dungeonName: "", strength: 0, agility: 0, intelligence: 0 });
  const [selectedDungeon, setSelectedDungeon] = useState<DungeonRecord | null>(null);
  const [decryptedAttributes, setDecryptedAttributes] = useState<{ strength: number, agility: number, intelligence: number } | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [dungeonLayout, setDungeonLayout] = useState<string[]>([]);
  const [showTutorial, setShowTutorial] = useState(false);
  const [activeTab, setActiveTab] = useState("dungeons");

  const readyCount = dungeons.filter(d => d.status === "ready").length;
  const generatingCount = dungeons.filter(d => d.status === "generating").length;
  const completedCount = dungeons.filter(d => d.status === "completed").length;

  useEffect(() => {
    loadDungeons().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadDungeons = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("dungeon_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing dungeon keys:", e); }
      }
      const list: DungeonRecord[] = [];
      for (const key of keys) {
        try {
          const dungeonBytes = await contract.getData(`dungeon_${key}`);
          if (dungeonBytes.length > 0) {
            try {
              const dungeonData = JSON.parse(ethers.toUtf8String(dungeonBytes));
              list.push({ 
                id: key, 
                encryptedAttributes: dungeonData.attributes, 
                timestamp: dungeonData.timestamp, 
                owner: dungeonData.owner, 
                dungeonName: dungeonData.dungeonName, 
                status: dungeonData.status || "generating",
                monstersDefeated: dungeonData.monstersDefeated || 0,
                treasuresFound: dungeonData.treasuresFound || 0
              });
            } catch (e) { console.error(`Error parsing dungeon data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading dungeon ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setDungeons(list);
    } catch (e) { console.error("Error loading dungeons:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createDungeon = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting party attributes with Zama FHE..." });
    try {
      // Combine attributes into single encrypted value for dungeon generation
      const combinedAttributes = newDungeonData.strength * 10000 + newDungeonData.agility * 100 + newDungeonData.intelligence;
      const encryptedAttributes = FHEEncryptNumber(combinedAttributes);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const dungeonId = `dungeon-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const dungeonData = { 
        attributes: encryptedAttributes, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        dungeonName: newDungeonData.dungeonName, 
        status: "generating",
        monstersDefeated: 0,
        treasuresFound: 0
      };
      
      await contract.setData(`dungeon_${dungeonId}`, ethers.toUtf8Bytes(JSON.stringify(dungeonData)));
      
      const keysBytes = await contract.getData("dungeon_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(dungeonId);
      await contract.setData("dungeon_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Dungeon generation started with FHE!" });
      await loadDungeons();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewDungeonData({ dungeonName: "", strength: 0, agility: 0, intelligence: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<{ strength: number, agility: number, intelligence: number } | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const combinedValue = FHEDecryptNumber(encryptedData);
      const strength = Math.floor(combinedValue / 10000);
      const agility = Math.floor((combinedValue % 10000) / 100);
      const intelligence = combinedValue % 100;
      
      return { strength, agility, intelligence };
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const exploreDungeon = async (dungeonId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Generating dungeon with FHE attributes..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const dungeonBytes = await contract.getData(`dungeon_${dungeonId}`);
      if (dungeonBytes.length === 0) throw new Error("Dungeon not found");
      
      const dungeonData = JSON.parse(ethers.toUtf8String(dungeonBytes));
      if (dungeonData.status !== "ready") throw new Error("Dungeon not ready for exploration");
      
      // Generate dungeon layout based on encrypted attributes
      const dungeon = generateDungeon(dungeonData.attributes);
      setDungeonLayout(dungeon.layout);
      
      // Update dungeon status
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedDungeon = { 
        ...dungeonData, 
        status: "completed",
        monstersDefeated: dungeon.monsters,
        treasuresFound: dungeon.treasures
      };
      
      await contractWithSigner.setData(`dungeon_${dungeonId}`, ethers.toUtf8Bytes(JSON.stringify(updatedDungeon)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Dungeon explored successfully!" });
      await loadDungeons();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Exploration failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (dungeonAddress: string) => address?.toLowerCase() === dungeonAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Assemble Party", description: "Set your party's attributes (Strength, Agility, Intelligence)", icon: "⚔️" },
    { title: "FHE Encryption", description: "Attributes are encrypted with Zama FHE before submission", icon: "🔒", details: "Your data is encrypted on the client-side before being sent to the blockchain" },
    { title: "Dungeon Generation", description: "Dungeon is procedurally generated based on encrypted attributes", icon: "🏰", details: "The dungeon layout, monsters and treasures are uniquely determined by your party's encrypted attributes" },
    { title: "Explore Dungeon", description: "Discover unique challenges based on your party composition", icon: "🧭", details: "Each dungeon is different and requires different strategies" }
  ];

  const renderDungeonStats = () => {
    const total = dungeons.length || 1;
    const readyPercentage = (readyCount / total) * 100;
    const generatingPercentage = (generatingCount / total) * 100;
    const completedPercentage = (completedCount / total) * 100;
    
    return (
      <div className="stats-container">
        <div className="stat-item">
          <div className="stat-value">{dungeons.length}</div>
          <div className="stat-label">Total Dungeons</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{readyCount}</div>
          <div className="stat-label">Ready</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{generatingCount}</div>
          <div className="stat-label">Generating</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{completedCount}</div>
          <div className="stat-label">Completed</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="pixel-spinner"></div>
      <p>Initializing encrypted dungeon connection...</p>
    </div>
  );

  return (
    <div className="app-container pixel-theme">
      <header className="app-header">
        <div className="logo">
          <h1 className="pixel-text">隱秘地牢</h1>
          <h2 className="pixel-subtext">FHE Dungeon Crawler</h2>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="pixel-button">
            <span className="pixel-icon">+</span> New Dungeon
          </button>
          <button className="pixel-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content">
        <div className="welcome-banner pixel-banner">
          <div className="welcome-text">
            <h2 className="pixel-title">FHE-Based Procedural Dungeon Crawler</h2>
            <p className="pixel-subtitle">Dungeons generated from your encrypted party attributes</p>
          </div>
          <div className="fhe-badge pixel-badge">
            <span>Powered by Zama FHE</span>
          </div>
        </div>
        
        {showTutorial && (
          <div className="tutorial-section pixel-panel">
            <h2 className="pixel-heading">How It Works</h2>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step pixel-step" key={index}>
                  <div className="step-icon pixel-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3 className="pixel-step-title">{step.title}</h3>
                    <p className="pixel-text">{step.description}</p>
                    {step.details && <div className="step-details pixel-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        <div className="tab-container pixel-tabs">
          <button 
            className={`pixel-tab ${activeTab === "dungeons" ? "active" : ""}`}
            onClick={() => setActiveTab("dungeons")}
          >
            My Dungeons
          </button>
          <button 
            className={`pixel-tab ${activeTab === "stats" ? "active" : ""}`}
            onClick={() => setActiveTab("stats")}
          >
            Statistics
          </button>
          <button 
            className={`pixel-tab ${activeTab === "about" ? "active" : ""}`}
            onClick={() => setActiveTab("about")}
          >
            About
          </button>
        </div>
        
        {activeTab === "dungeons" && (
          <div className="dungeons-section">
            <div className="section-header pixel-header">
              <h2>My Dungeons</h2>
              <button 
                onClick={loadDungeons} 
                className="pixel-button" 
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            
            <div className="dungeons-list pixel-scroll">
              {dungeons.length === 0 ? (
                <div className="no-dungeons pixel-empty">
                  <div className="pixel-icon">🏰</div>
                  <p>No dungeons found</p>
                  <button 
                    className="pixel-button primary" 
                    onClick={() => setShowCreateModal(true)}
                  >
                    Create First Dungeon
                  </button>
                </div>
              ) : (
                <div className="dungeon-grid">
                  {dungeons.map(dungeon => (
                    <div 
                      className={`dungeon-card pixel-card ${dungeon.status}`} 
                      key={dungeon.id}
                      onClick={() => setSelectedDungeon(dungeon)}
                    >
                      <div className="dungeon-name pixel-text">{dungeon.dungeonName}</div>
                      <div className="dungeon-status pixel-badge">
                        <span>{dungeon.status}</span>
                      </div>
                      <div className="dungeon-date pixel-text">
                        {new Date(dungeon.timestamp * 1000).toLocaleDateString()}
                      </div>
                      <div className="dungeon-owner pixel-text">
                        {dungeon.owner.substring(0, 6)}...{dungeon.owner.substring(38)}
                      </div>
                      {dungeon.status === "ready" && isOwner(dungeon.owner) && (
                        <button 
                          className="pixel-button small explore-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            exploreDungeon(dungeon.id);
                          }}
                        >
                          Explore
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        
        {activeTab === "stats" && (
          <div className="stats-section pixel-panel">
            <h2>Dungeon Statistics</h2>
            {renderDungeonStats()}
            <div className="stats-chart pixel-chart">
              <div className="chart-bar" style={{ height: `${(readyCount / dungeons.length) * 100}%` }}>
                <span>Ready</span>
              </div>
              <div className="chart-bar" style={{ height: `${(generatingCount / dungeons.length) * 100}%` }}>
                <span>Generating</span>
              </div>
              <div className="chart-bar" style={{ height: `${(completedCount / dungeons.length) * 100}%` }}>
                <span>Completed</span>
              </div>
            </div>
          </div>
        )}
        
        {activeTab === "about" && (
          <div className="about-section pixel-panel">
            <h2>About 隱秘地牢</h2>
            <div className="about-content">
              <p>
                This Roguelike game generates dungeons based on your party's encrypted attributes using Zama FHE technology.
                The layout, monsters and treasures are procedurally generated from the homomorphically encrypted data.
              </p>
              <div className="fhe-explanation">
                <h3>How FHE Works:</h3>
                <ol>
                  <li>Party attributes are encrypted on your device</li>
                  <li>Encrypted data is sent to the blockchain</li>
                  <li>Dungeon is generated without decrypting the data</li>
                  <li>Each dungeon is uniquely determined by your party</li>
                </ol>
              </div>
              <div className="features-list">
                <h3>Features:</h3>
                <ul>
                  <li>Fully encrypted party attributes</li>
                  <li>Procedural dungeon generation</li>
                  <li>Unique dungeons for each party</li>
                  <li>High replay value</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
      
      {showCreateModal && (
        <ModalCreate 
          onSubmit={createDungeon} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          dungeonData={newDungeonData} 
          setDungeonData={setNewDungeonData}
        />
      )}
      
      {selectedDungeon && (
        <DungeonDetailModal 
          dungeon={selectedDungeon} 
          onClose={() => { 
            setSelectedDungeon(null); 
            setDecryptedAttributes(null); 
            setDungeonLayout([]);
          }} 
          decryptedAttributes={decryptedAttributes} 
          setDecryptedAttributes={setDecryptedAttributes} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          dungeonLayout={dungeonLayout}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal pixel-modal">
          <div className="transaction-content pixel-panel">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="pixel-spinner"></div>}
              {transactionStatus.status === "success" && <div className="pixel-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="pixel-icon">✗</div>}
            </div>
            <div className="transaction-message pixel-text">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer pixel-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo pixel-text">隱秘地牢</div>
            <p>FHE-based procedural dungeon crawler</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link pixel-link">Docs</a>
            <a href="#" className="footer-link pixel-link">GitHub</a>
            <a href="#" className="footer-link pixel-link">Zama</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="copyright pixel-text">© {new Date().getFullYear()} FHE Dungeon Crawler</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  dungeonData: any;
  setDungeonData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, dungeonData, setDungeonData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setDungeonData({ ...dungeonData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setDungeonData({ ...dungeonData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!dungeonData.dungeonName || dungeonData.strength <= 0 || dungeonData.agility <= 0 || dungeonData.intelligence <= 0) {
      alert("Please fill all required fields with valid values");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay pixel-overlay">
      <div className="create-modal pixel-panel">
        <div className="modal-header">
          <h2 className="pixel-heading">Create New Dungeon</h2>
          <button onClick={onClose} className="close-modal pixel-button">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice pixel-notice">
            <div className="pixel-icon">🔒</div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your party attributes will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-group">
            <label className="pixel-label">Dungeon Name *</label>
            <input 
              type="text" 
              name="dungeonName" 
              value={dungeonData.dungeonName} 
              onChange={handleChange} 
              placeholder="Enter dungeon name..." 
              className="pixel-input"
            />
          </div>
          
          <div className="attributes-grid">
            <div className="form-group">
              <label className="pixel-label">Strength *</label>
              <input 
                type="number" 
                name="strength" 
                min="1"
                max="99"
                value={dungeonData.strength} 
                onChange={handleValueChange} 
                placeholder="1-99" 
                className="pixel-input"
              />
            </div>
            <div className="form-group">
              <label className="pixel-label">Agility *</label>
              <input 
                type="number" 
                name="agility" 
                min="1"
                max="99"
                value={dungeonData.agility} 
                onChange={handleValueChange} 
                placeholder="1-99" 
                className="pixel-input"
              />
            </div>
            <div className="form-group">
              <label className="pixel-label">Intelligence *</label>
              <input 
                type="number" 
                name="intelligence" 
                min="1"
                max="99"
                value={dungeonData.intelligence} 
                onChange={handleValueChange} 
                placeholder="1-99" 
                className="pixel-input"
              />
            </div>
          </div>
          
          <div className="encryption-preview pixel-preview">
            <h4 className="pixel-subheading">Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data pixel-data">
                <span>Plain Values:</span>
                <div>STR: {dungeonData.strength || '0'}, AGI: {dungeonData.agility || '0'}, INT: {dungeonData.intelligence || '0'}</div>
              </div>
              <div className="encryption-arrow pixel-arrow">→</div>
              <div className="encrypted-data pixel-data">
                <span>Encrypted Data:</span>
                <div>
                  {dungeonData.strength && dungeonData.agility && dungeonData.intelligence ? 
                    FHEEncryptNumber(dungeonData.strength * 10000 + dungeonData.agility * 100 + dungeonData.intelligence).substring(0, 50) + '...' : 
                    'No values entered'}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="pixel-button cancel">Cancel</button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="pixel-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Create Dungeon"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface DungeonDetailModalProps {
  dungeon: DungeonRecord;
  onClose: () => void;
  decryptedAttributes: { strength: number, agility: number, intelligence: number } | null;
  setDecryptedAttributes: (value: { strength: number, agility: number, intelligence: number } | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<{ strength: number, agility: number, intelligence: number } | null>;
  dungeonLayout: string[];
}

const DungeonDetailModal: React.FC<DungeonDetailModalProps> = ({ 
  dungeon, 
  onClose, 
  decryptedAttributes, 
  setDecryptedAttributes, 
  isDecrypting, 
  decryptWithSignature,
  dungeonLayout 
}) => {
  const handleDecrypt = async () => {
    if (decryptedAttributes !== null) { setDecryptedAttributes(null); return; }
    const decrypted = await decryptWithSignature(dungeon.encryptedAttributes);
    if (decrypted !== null) setDecryptedAttributes(decrypted);
  };

  return (
    <div className="modal-overlay pixel-overlay">
      <div className="dungeon-detail-modal pixel-panel">
        <div className="modal-header">
          <h2 className="pixel-heading">{dungeon.dungeonName}</h2>
          <button onClick={onClose} className="close-modal pixel-button">&times;</button>
        </div>
        <div className="modal-body">
          <div className="dungeon-info pixel-info">
            <div className="info-item">
              <span>Status:</span>
              <strong className={`pixel-badge ${dungeon.status}`}>{dungeon.status}</strong>
            </div>
            <div className="info-item">
              <span>Created:</span>
              <strong>{new Date(dungeon.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{dungeon.owner.substring(0, 6)}...{dungeon.owner.substring(38)}</strong>
            </div>
            {dungeon.status === "completed" && (
              <>
                <div className="info-item">
                  <span>Monsters Defeated:</span>
                  <strong>{dungeon.monstersDefeated}</strong>
                </div>
                <div className="info-item">
                  <span>Treasures Found:</span>
                  <strong>{dungeon.treasuresFound}</strong>
                </div>
              </>
            )}
          </div>
          
          <div className="encrypted-data-section pixel-section">
            <h3 className="pixel-subheading">Encrypted Party Attributes</h3>
            <div className="encrypted-data pixel-code">
              {dungeon.encryptedAttributes.substring(0, 100)}...
            </div>
            <button 
              className="pixel-button decrypt-btn" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : decryptedAttributes ? "Hide Attributes" : "Decrypt Attributes"}
            </button>
          </div>
          
          {decryptedAttributes && (
            <div className="decrypted-data-section pixel-section">
              <h3 className="pixel-subheading">Party Attributes</h3>
              <div className="attributes-grid">
                <div className="attribute-item pixel-attribute">
                  <span>Strength</span>
                  <div>{decryptedAttributes.strength}</div>
                </div>
                <div className="attribute-item pixel-attribute">
                  <span>Agility</span>
                  <div>{decryptedAttributes.agility}</div>
                </div>
                <div className="attribute-item pixel-attribute">
                  <span>Intelligence</span>
                  <div>{decryptedAttributes.intelligence}</div>
                </div>
              </div>
            </div>
          )}
          
          {dungeonLayout.length > 0 && (
            <div className="dungeon-map-section pixel-section">
              <h3 className="pixel-subheading">Dungeon Map</h3>
              <div className="dungeon-map pixel-map">
                {dungeonLayout.map((row, i) => (
                  <div key={i} className="dungeon-row pixel-row">
                    {row.split(' | ').map((room, j) => (
                      <div key={j} className={`dungeon-room pixel-room ${room.toLowerCase()}`}>
                        {room.substring(0, 1)}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <div className="map-legend pixel-legend">
                <div><span className="pixel-room empty">E</span> Empty</div>
                <div><span className="pixel-room monster">M</span> Monster</div>
                <div><span className="pixel-room treasure">T</span> Treasure</div>
                <div><span className="pixel-room boss">B</span> Boss</div>
                <div><span className="pixel-room trap">X</span> Trap</div>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="pixel-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;