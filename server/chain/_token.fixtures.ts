// Token-shaped protocol contracts that must NOT be judged boilerplate, and token templates that must.
// Sources are stand-ins with the structure of the verified bundles (library files or pasted base
// contracts, inheritance, number of custom lines); ABIs are the function surfaces of the deployed
// contracts. Read live through readEvm + evaluateRead on 2026-10-05 (Ethereum, Sourcify):
//   sUSDe   StakedUSDeV2     0x9D39A5DE30e57443BfF2A8307A4256c8797A3497   full match,    256 custom lines, ERC-4626 + cooldowns
//   rETH    RocketTokenRETH  0xae78736Cd615f374D3085123A210448E74Fc6393   partial match, 166 custom lines, collateral / exchange rate
//   sfrxETH sfrxETH          0xac3E018457B222d93114458476f3E3416Abbe38F   full match,     93 custom lines, xERC4626 vault
//   DAI     Dai              0x6B175474E89094C44Da98b954EedeAC495271d0F   partial match, 129 custom lines, wards / rely / deny / move
//   USDT    TetherToken      0xdAC17F958D2ee523a2206206994597C13D831ec7   partial match, 185 custom lines, pasted ERC20 base, no library
// (all five were judged boilerplate before the token rules took the ABI surface into account; all kept now)
// Pure data, no I/O.

export interface TokenFixture {
  name: string
  sources: { path: string; text: string }[]
  abi: string[]
}

const body = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `        ${tag}${i} = ${tag}${i} + ${i};`).join('\n')
/** A contract block with `n` non-blank custom lines (the declaration and the closing brace included). */
const contract = (decl: string, n: number, tag: string) => `${decl} {\n    function f_${tag}() internal {\n${body(Math.max(0, n - 4), tag)}\n    }\n}\n`
const lib = (path: string, decl: string, n = 120) => ({ path, text: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n${contract(decl, n, 'l')}` })

const ERC20_ABI = [
  'name()',
  'symbol()',
  'decimals()',
  'totalSupply()',
  'balanceOf(address)',
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
  'approve(address,uint256)',
  'allowance(address,address)',
]
const ERC4626_ABI = [
  'asset()',
  'totalAssets()',
  'convertToShares(uint256)',
  'convertToAssets(uint256)',
  'maxDeposit(address)',
  'maxMint(address)',
  'maxWithdraw(address)',
  'maxRedeem(address)',
  'previewDeposit(uint256)',
  'previewMint(uint256)',
  'previewWithdraw(uint256)',
  'previewRedeem(uint256)',
  'deposit(uint256,address)',
  'mint(uint256,address)',
  'withdraw(uint256,address,address)',
  'redeem(uint256,address,address)',
]
const PERMIT_ABI = ['DOMAIN_SEPARATOR()', 'nonces(address)', 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)', 'eip712Domain()']
const ROLES_ABI = ['DEFAULT_ADMIN_ROLE()', 'hasRole(bytes32,address)', 'getRoleAdmin(bytes32)', 'grantRole(bytes32,address)', 'revokeRole(bytes32,address)', 'renounceRole(bytes32,address)', 'supportsInterface(bytes4)', 'owner()']

export const SUSDE: TokenFixture = {
  name: 'StakedUSDeV2',
  sources: [
    lib('lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol', 'abstract contract ERC20'),
    lib('lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol', 'abstract contract ERC4626 is ERC20'),
    lib('lib/openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Permit.sol', 'abstract contract ERC20Permit is ERC20'),
    lib('lib/openzeppelin-contracts/contracts/access/AccessControl.sol', 'abstract contract AccessControl'),
    { path: 'contracts/StakedUSDe.sol', text: `pragma solidity 0.8.19;\n${contract('contract StakedUSDe is SingleAdminAccessControl, ReentrancyGuard, ERC20Permit, ERC4626', 150, 's')}` },
    { path: 'contracts/StakedUSDeV2.sol', text: `pragma solidity 0.8.19;\n${contract('contract StakedUSDeV2 is IStakedUSDeCooldown, StakedUSDe', 106, 'c')}` },
  ],
  abi: [
    ...ERC20_ABI,
    ...ERC4626_ABI,
    ...PERMIT_ABI,
    ...ROLES_ABI,
    'MAX_COOLDOWN_DURATION()',
    'cooldownAssets(uint256)',
    'cooldownShares(uint256)',
    'cooldownDuration()',
    'cooldowns(address)',
    'unstake(address)',
    'silo()',
    'setCooldownDuration(uint24)',
    'transferInRewards(uint256)',
    'getUnvestedAmount()',
    'vestingAmount()',
    'lastDistributionTimestamp()',
    'redistributeLockedAmount(address,address)',
    'addToBlacklist(address,bool)',
    'removeFromBlacklist(address,bool)',
    'rescueTokens(address,uint256,address)',
  ],
}

export const RETH: TokenFixture = {
  name: 'RocketTokenRETH',
  sources: [
    lib('@openzeppelin/contracts/token/ERC20/ERC20.sol', 'contract ERC20'),
    lib('@openzeppelin/contracts/math/SafeMath.sol', 'library SafeMath', 60),
    { path: 'contracts/contract/RocketBase.sol', text: `pragma solidity 0.7.6;\n${contract('abstract contract RocketBase', 60, 'b')}` },
    { path: 'contracts/contract/token/RocketTokenRETH.sol', text: `pragma solidity 0.7.6;\n${contract('contract RocketTokenRETH is RocketBase, ERC20, RocketTokenRETHInterface', 106, 'r')}` },
  ],
  abi: [
    ...ERC20_ABI,
    'increaseAllowance(address,uint256)',
    'decreaseAllowance(address,uint256)',
    'version()',
    'getEthValue(uint256)',
    'getRethValue(uint256)',
    'getExchangeRate()',
    'getTotalCollateral()',
    'getCollateralRate()',
    'depositExcess()',
    'depositExcessCollateral()',
    'mint(uint256,address)',
    'burn(uint256)',
  ],
}

export const SFRXETH: TokenFixture = {
  name: 'sfrxETH',
  sources: [
    lib('lib/solmate/src/tokens/ERC20.sol', 'abstract contract ERC20'),
    lib('lib/solmate/src/mixins/ERC4626.sol', 'abstract contract ERC4626 is ERC20'),
    lib('lib/solmate/src/utils/ReentrancyGuard.sol', 'abstract contract ReentrancyGuard', 20),
    { path: 'lib/ERC4626/src/xERC4626.sol', text: `pragma solidity ^0.8.0;\n${contract('abstract contract xERC4626 is IxERC4626, ERC4626', 47, 'x')}` },
    { path: 'src/sfrxETH.sol', text: `pragma solidity ^0.8.0;\n${contract('contract sfrxETH is xERC4626, ReentrancyGuard', 46, 'f')}` },
  ],
  abi: [...ERC20_ABI, ...ERC4626_ABI, ...PERMIT_ABI.slice(0, 3), 'syncRewards()', 'rewardsCycleEnd()', 'rewardsCycleLength()', 'lastRewardAmount()', 'lastSync()', 'pricePerShare()', 'depositWithSignature(uint256,address,uint256,bool,uint8,bytes32,bytes32)'],
}

export const DAI: TokenFixture = {
  name: 'Dai',
  sources: [
    {
      path: 'Dai.sol',
      text: `pragma solidity =0.5.12;\n${contract('contract LibNote', 20, 'n')}\n${contract('contract Dai is LibNote', 109, 'd')}`,
    },
  ],
  abi: [
    ...ERC20_ABI,
    'version()',
    'nonces(address)',
    'DOMAIN_SEPARATOR()',
    'PERMIT_TYPEHASH()',
    'wards(address)',
    'rely(address)',
    'deny(address)',
    'mint(address,uint256)',
    'burn(address,uint256)',
    'push(address,uint256)',
    'pull(address,uint256)',
    'move(address,address,uint256)',
    'permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)',
  ],
}

export const USDT: TokenFixture = {
  name: 'TetherToken',
  sources: [
    {
      path: 'TetherToken.sol',
      text: [
        'pragma solidity ^0.4.17;',
        contract('library SafeMath', 40, 'm'),
        contract('contract Ownable', 20, 'o'),
        contract('contract ERC20Basic', 10, 'eb'),
        contract('contract ERC20 is ERC20Basic', 10, 'e'),
        contract('contract BasicToken is Ownable, ERC20Basic', 40, 'bt'),
        contract('contract StandardToken is BasicToken, ERC20', 40, 'st'),
        contract('contract Pausable is Ownable', 20, 'p'),
        contract('contract BlackList is Ownable, BasicToken', 30, 'bl'),
        contract('contract UpgradedStandardToken is StandardToken', 10, 'u'),
        contract('contract TetherToken is Pausable, StandardToken, BlackList', 75, 't'),
      ].join('\n'),
    },
  ],
  abi: [
    ...ERC20_ABI,
    'deprecate(address)',
    'deprecated()',
    'addBlackList(address)',
    'removeBlackList(address)',
    'getBlackListStatus(address)',
    'isBlackListed(address)',
    'destroyBlackFunds(address)',
    'upgradedAddress()',
    'balances(address)',
    'allowed(address,address)',
    'maximumFee()',
    '_totalSupply()',
    'basisPointsRate()',
    'setParams(uint256,uint256)',
    'issue(uint256)',
    'redeem(uint256)',
    'pause()',
    'unpause()',
    'paused()',
    'getOwner()',
    'owner()',
    'transferOwnership(address)',
    'MAX_UINT()',
  ],
}

export const PROTOCOL_TOKENS: TokenFixture[] = [SUSDE, RETH, SFRXETH, DAI, USDT]

/** An OpenZeppelin token with 120 custom lines that exposes only token / owner / launch functions. */
export const PLAIN_OZ_TOKEN: TokenFixture = {
  name: 'GigaChadToken',
  sources: [lib('@openzeppelin/contracts/token/ERC20/ERC20.sol', 'contract ERC20'), lib('@openzeppelin/contracts/access/Ownable.sol', 'abstract contract Ownable', 40), { path: 'contracts/GigaChad.sol', text: `pragma solidity ^0.8.20;\n${contract('contract GigaChadToken is ERC20, Ownable', 120, 'g')}` }],
  abi: [...ERC20_ABI, 'owner()', 'renounceOwnership()', 'transferOwnership(address)', 'mint(address,uint256)', 'burn(uint256)', 'setMaxWallet(uint256)', 'airdrop(address[],uint256)'],
}
