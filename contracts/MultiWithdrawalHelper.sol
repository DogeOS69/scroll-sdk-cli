// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.24;

// import {IMoat} from "./IMoat.sol";
// import {IL2ScrollMessenger, IScrollMessenger} from "./IL2ScrollMessenger.sol";
interface IMoat {
  // --- Errors --- //

  error ErrorZeroAddress();
  error ErrorFeeNotCovered();
  error ErrorBelowMinimumWithdrawal();
  error ErrorOnlyMessenger(address sender, address expected);
  error ErrorUnprovenL1Message(); // Note: This seems unused in Moat.sol currently
  error ErrorTargetRevert();
  error ErrorInvalidDataLength(uint256 length);
  error ErrorFeeTransferFailed();
  error Unauthorized(); // From OwnableBase inheritance

  // --- Events --- //

  event WithdrawalFeeUpdated(uint256 oldFee, uint256 newFee);
  event DepositFeeUpdated(uint256 oldFee, uint256 newFee);
  event MinWithdrawalUpdated(uint256 oldMin, uint256 newMin);
  event FeeRecipientUpdated(address indexed oldRecip, address indexed newRecip);
  event BasculeVerifierUpdated(address indexed oldVerifier, address indexed newVerifier);
  event WithdrawalQueued(address indexed sender, address indexed target, uint256 amount, uint256 fee);
  event MessengerUpdated(address indexed oldMessenger, address indexed newMessenger);
  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner); // From OwnableBase inheritance

  event DepositReceived(address indexed sender, address indexed target, uint256 amount, uint256 fee);

  // --- Functions --- //

  // Getters for public state variables
  function messenger() external view returns (address);

  function basculeVerifier() external view returns (address);

  function withdrawalFee() external view returns (uint256);

  function depositFee() external view returns (uint256);

  function minWithdrawalAmount() external view returns (uint256);

  function feeRecipient() external view returns (address);

  function owner() external view returns (address); // From OwnableBase inheritance

  // Setters
  function updateMessenger(address _newMessenger) external;

  function setWithdrawalFee(uint256 _newFee) external;

  function setDepositFee(uint256 _newFee) external;

  function setMinWithdrawal(uint256 _newMin) external;

  function setFeeRecipient(address _newRecip) external;

  function setBascule(address _newVerifier) external;

  // Core Logic
  function handleL1Message(address _target, bytes32 _depositID) external payable;

  function withdrawToL1(address _target) external payable;

  // OwnableBase functions
  function transferOwnership(address newOwner) external;

  function renounceOwnership() external;
}

interface IScrollMessenger {
  /**********
   * Events *
   **********/

  /// @notice Emitted when a cross domain message is sent.
  /// @param sender The address of the sender who initiates the message.
  /// @param target The address of target contract to call.
  /// @param value The amount of value passed to the target contract.
  /// @param messageNonce The nonce of the message.
  /// @param gasLimit The optional gas limit passed to L1 or L2.
  /// @param message The calldata passed to the target contract.
  event SentMessage(
    address indexed sender,
    address indexed target,
    uint256 value,
    uint256 messageNonce,
    uint256 gasLimit,
    bytes message
  );

  /// @notice Emitted when a cross domain message is relayed successfully.
  /// @param messageHash The hash of the message.
  event RelayedMessage(bytes32 indexed messageHash);

  /// @notice Emitted when a cross domain message is failed to relay.
  /// @param messageHash The hash of the message.
  event FailedRelayedMessage(bytes32 indexed messageHash);

  /**********
   * Errors *
   **********/

  /// @dev Thrown when the given address is `address(0)`.
  error ErrorZeroAddress();

  /*************************
   * Public View Functions *
   *************************/

  /// @notice Return the sender of a cross domain message.
  function xDomainMessageSender() external view returns (address);

  /*****************************
   * Public Mutating Functions *
   *****************************/

  /// @notice Send cross chain message from L1 to L2 or L2 to L1.
  /// @param target The address of account who receive the message.
  /// @param value The amount of ether passed when call target contract.
  /// @param message The content of the message.
  /// @param gasLimit Gas limit required to complete the message relay on corresponding chain.
  function sendMessage(address target, uint256 value, bytes calldata message, uint256 gasLimit) external payable;

  /// @notice Send cross chain message from L1 to L2 or L2 to L1.
  /// @param target The address of account who receive the message.
  /// @param value The amount of ether passed when call target contract.
  /// @param message The content of the message.
  /// @param gasLimit Gas limit required to complete the message relay on corresponding chain.
  /// @param refundAddress The address of account who will receive the refunded fee.
  function sendMessage(
    address target,
    uint256 value,
    bytes calldata message,
    uint256 gasLimit,
    address refundAddress
  ) external payable;
}

interface IL2ScrollMessenger is IScrollMessenger {
  /**********
   * Events *
   **********/

  /// @notice Emitted when the maximum number of times each message can fail in L2 is updated.
  /// @param oldMaxFailedExecutionTimes The old maximum number of times each message can fail in L2.
  /// @param newMaxFailedExecutionTimes The new maximum number of times each message can fail in L2.
  event UpdateMaxFailedExecutionTimes(uint256 oldMaxFailedExecutionTimes, uint256 newMaxFailedExecutionTimes);

  /*****************************
   * Public Mutating Functions *
   *****************************/

  /// @notice execute L1 => L2 message
  /// @dev Make sure this is only called by privileged accounts.
  /// @param from The address of the sender of the message.
  /// @param to The address of the recipient of the message.
  /// @param value The msg.value passed to the message call.
  /// @param nonce The nonce of the message to avoid replay attack.
  /// @param message The content of the message.
  function relayMessage(address from, address to, uint256 value, uint256 nonce, bytes calldata message) external;
}

contract MultiWithdrawalHelper {
  address payable public moat;

  constructor(address payable _moat) {
    moat = _moat;
  }

  function setMoat(address payable _moat) public {
    moat = _moat;
  }

  function mutiWithdrawal(uint256 count, uint256 amount, address target) external payable {
    for (uint256 i = 0; i < count; i++) {
      IMoat(moat).withdrawToL1{value: amount}(target);
    }
  }

  receive() external payable {}
}
