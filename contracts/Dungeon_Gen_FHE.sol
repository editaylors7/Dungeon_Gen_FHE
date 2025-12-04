pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DungeonGenFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Batch {
        uint256 id;
        bool open;
        uint256 totalEncryptedPartyStrength; // euint32 ciphertext
        uint256 totalEncryptedPartyAgility;  // euint32 ciphertext
        uint256 totalEncryptedPartyIntellect; // euint32 ciphertext
        uint256 dungeonSeed; // euint32 ciphertext
    }
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId = 1;

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidBatchId();

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused();
    event ContractUnpaused();
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event PartyAttributesSubmitted(uint256 indexed batchId, address indexed provider);
    event DungeonSeedGenerated(uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 strength, uint256 agility, uint256 intellect, uint256 seed);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 30; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (paused != _paused) {
            paused = _paused;
            if (_paused) {
                emit ContractPaused();
            } else {
                emit ContractUnpaused();
            }
        }
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, _cooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batches[currentBatchId].open) {
            currentBatchId++;
        }
        batches[currentBatchId] = Batch({
            id: currentBatchId,
            open: true,
            totalEncryptedPartyStrength: 0, // Initialized to zero ciphertext
            totalEncryptedPartyAgility: 0,  // Initialized to zero ciphertext
            totalEncryptedPartyIntellect: 0, // Initialized to zero ciphertext
            dungeonSeed: 0 // Initialized to zero ciphertext
        });
        // Initialize FHE context for the batch's encrypted fields
        _initIfNeeded(euint32.wrap(batches[currentBatchId].totalEncryptedPartyStrength));
        _initIfNeeded(euint32.wrap(batches[currentBatchId].totalEncryptedPartyAgility));
        _initIfNeeded(euint32.wrap(batches[currentBatchId].totalEncryptedPartyIntellect));
        _initIfNeeded(euint32.wrap(batches[currentBatchId].dungeonSeed));

        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batches[currentBatchId].open) revert BatchClosed();
        batches[currentBatchId].open = false;
        emit BatchClosed(currentBatchId);
    }

    function submitPartyAttributes(
        euint32 encryptedStrength,
        euint32 encryptedAgility,
        euint32 encryptedIntellect
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batches[currentBatchId].open) revert BatchClosed();

        lastSubmissionTime[msg.sender] = block.timestamp;

        euint32 memory currentEncryptedStrength = euint32.wrap(batches[currentBatchId].totalEncryptedPartyStrength);
        euint32 memory currentEncryptedAgility = euint32.wrap(batches[currentBatchId].totalEncryptedPartyAgility);
        euint32 memory currentEncryptedIntellect = euint32.wrap(batches[currentBatchId].totalEncryptedPartyIntellect);

        euint32 memory newEncryptedStrength = FHE.add(currentEncryptedStrength, encryptedStrength);
        euint32 memory newEncryptedAgility = FHE.add(currentEncryptedAgility, encryptedAgility);
        euint32 memory newEncryptedIntellect = FHE.add(currentEncryptedIntellect, encryptedIntellect);

        batches[currentBatchId].totalEncryptedPartyStrength = newEncryptedStrength.toBytes32();
        batches[currentBatchId].totalEncryptedPartyAgility = newEncryptedAgility.toBytes32();
        batches[currentBatchId].totalEncryptedPartyIntellect = newEncryptedIntellect.toBytes32();

        emit PartyAttributesSubmitted(currentBatchId, msg.sender);
    }

    function generateDungeonSeed() external onlyProvider whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!batches[currentBatchId].open) revert BatchClosed(); // Must be called before batch is closed

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 memory strength = euint32.wrap(batches[currentBatchId].totalEncryptedPartyStrength);
        euint32 memory agility = euint32.wrap(batches[currentBatchId].totalEncryptedPartyAgility);
        euint32 memory intellect = euint32.wrap(batches[currentBatchId].totalEncryptedPartyIntellect);

        // Homomorphically compute dungeonSeed = (strength * agility + intellect) % (2^32 - 1)
        // This is a placeholder for a more complex generation algorithm
        euint32 memory tempProduct = FHE.mul(strength, agility);
        euint32 memory tempSum = FHE.add(tempProduct, intellect);
        euint32 memory seed = tempSum; // For simplicity, use sum as seed. Real game might have more complex logic.

        batches[currentBatchId].dungeonSeed = seed.toBytes32();
        emit DungeonSeedGenerated(currentBatchId);

        // Prepare for decryption
        bytes32[] memory cts = new bytes32[](4);
        cts[0] = batches[currentBatchId].totalEncryptedPartyStrength;
        cts[1] = batches[currentBatchId].totalEncryptedPartyAgility;
        cts[2] = batches[currentBatchId].totalEncryptedPartyIntellect;
        cts[3] = batches[currentBatchId].dungeonSeed;

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];
        if (ctx.processed) revert ReplayAttempt();
        // Security: Replay protection ensures this callback is processed only once for a given requestId.

        Batch storage batch = batches[ctx.batchId];
        if (batch.id == 0) revert InvalidBatchId(); // Check if batch exists

        bytes32[] memory currentCts = new bytes32[](4);
        currentCts[0] = batch.totalEncryptedPartyStrength;
        currentCts[1] = batch.totalEncryptedPartyAgility;
        currentCts[2] = batch.totalEncryptedPartyIntellect;
        currentCts[3] = batch.dungeonSeed;

        bytes32 currentHash = _hashCiphertexts(currentCts);
        // Security: State verification ensures that the contract's state (ciphertexts)
        // has not changed since the decryption request was made. This prevents
        // scenarios where an attacker could alter the state after the request
        // but before decryption, leading to inconsistent or maliciously influenced results.
        if (currentHash != ctx.stateHash) revert StateMismatch();

        FHE.checkSignatures(requestId, cleartexts, proof);

        (uint256 strength, uint256 agility, uint256 intellect, uint256 seed) = abi.decode(cleartexts, (uint256, uint256, uint256, uint256));

        ctx.processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, strength, agility, intellect, seed);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 memory x) internal {
        if (!FHE.isInitialized(x)) {
            FHE.asEuint32(0); // Initialize with a dummy value if not already initialized
        }
    }

    function _requireInitialized(euint32 memory x) internal pure {
        if (!FHE.isInitialized(x)) revert("FHE context not initialized");
    }
}