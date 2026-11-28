/**
 * Core: Board Data
 *
 * The classic US board: 40 tiles, 16 Chance + 16 Community Chest cards.
 * All names live only in this file so a re-theme is a one-file edit.
 *
 * rent arrays: [base, 1 house, 2, 3, 4, hotel]
 * mortgage value = price / 2 (computed, not stored)
 *
 * Exports:
 *   - window.BOARD, window.CHANCE_CARDS, window.COMMUNITY_CARDS
 *   - window.LANDING_FREQ (AI weighting), window.tileGridPos()
 */

const BOARD = [
    { id: 0,  type: 'go',       name: 'GO' },
    { id: 1,  type: 'property', name: 'Mediterranean Avenue', group: 'brown',     price: 60,  houseCost: 50,  rent: [2, 10, 30, 90, 160, 250] },
    { id: 2,  type: 'chest',    name: 'Community Chest' },
    { id: 3,  type: 'property', name: 'Baltic Avenue',        group: 'brown',     price: 60,  houseCost: 50,  rent: [4, 20, 60, 180, 320, 450] },
    { id: 4,  type: 'tax',      name: 'Income Tax',           amount: 200 },
    { id: 5,  type: 'railroad', name: 'Reading Railroad',     group: 'railroad',  price: 200 },
    { id: 6,  type: 'property', name: 'Oriental Avenue',      group: 'lightblue', price: 100, houseCost: 50,  rent: [6, 30, 90, 270, 400, 550] },
    { id: 7,  type: 'chance',   name: 'Chance' },
    { id: 8,  type: 'property', name: 'Vermont Avenue',       group: 'lightblue', price: 100, houseCost: 50,  rent: [6, 30, 90, 270, 400, 550] },
    { id: 9,  type: 'property', name: 'Connecticut Avenue',   group: 'lightblue', price: 120, houseCost: 50,  rent: [8, 40, 100, 300, 450, 600] },
    { id: 10, type: 'jail',     name: 'Jail / Just Visiting' },
    { id: 11, type: 'property', name: 'St. Charles Place',    group: 'pink',      price: 140, houseCost: 100, rent: [10, 50, 150, 450, 625, 750] },
    { id: 12, type: 'utility',  name: 'Electric Company',     group: 'utility',   price: 150 },
    { id: 13, type: 'property', name: 'States Avenue',        group: 'pink',      price: 140, houseCost: 100, rent: [10, 50, 150, 450, 625, 750] },
    { id: 14, type: 'property', name: 'Virginia Avenue',      group: 'pink',      price: 160, houseCost: 100, rent: [12, 60, 180, 500, 700, 900] },
    { id: 15, type: 'railroad', name: 'Pennsylvania Railroad', group: 'railroad', price: 200 },
    { id: 16, type: 'property', name: 'St. James Place',      group: 'orange',    price: 180, houseCost: 100, rent: [14, 70, 200, 550, 750, 950] },
    { id: 17, type: 'chest',    name: 'Community Chest' },
    { id: 18, type: 'property', name: 'Tennessee Avenue',     group: 'orange',    price: 180, houseCost: 100, rent: [14, 70, 200, 550, 750, 950] },
    { id: 19, type: 'property', name: 'New York Avenue',      group: 'orange',    price: 200, houseCost: 100, rent: [16, 80, 220, 600, 800, 1000] },
    { id: 20, type: 'parking',  name: 'Free Parking' },
    { id: 21, type: 'property', name: 'Kentucky Avenue',      group: 'red',       price: 220, houseCost: 150, rent: [18, 90, 250, 700, 875, 1050] },
    { id: 22, type: 'chance',   name: 'Chance' },
    { id: 23, type: 'property', name: 'Indiana Avenue',       group: 'red',       price: 220, houseCost: 150, rent: [18, 90, 250, 700, 875, 1050] },
    { id: 24, type: 'property', name: 'Illinois Avenue',      group: 'red',       price: 240, houseCost: 150, rent: [20, 100, 300, 750, 925, 1100] },
    { id: 25, type: 'railroad', name: 'B&O Railroad',         group: 'railroad',  price: 200 },
    { id: 26, type: 'property', name: 'Atlantic Avenue',      group: 'yellow',    price: 260, houseCost: 150, rent: [22, 110, 330, 800, 975, 1150] },
    { id: 27, type: 'property', name: 'Ventnor Avenue',       group: 'yellow',    price: 260, houseCost: 150, rent: [22, 110, 330, 800, 975, 1150] },
    { id: 28, type: 'utility',  name: 'Water Works',          group: 'utility',   price: 150 },
    { id: 29, type: 'property', name: 'Marvin Gardens',       group: 'yellow',    price: 280, houseCost: 150, rent: [24, 120, 360, 850, 1025, 1200] },
    { id: 30, type: 'gotojail', name: 'Go To Jail' },
    { id: 31, type: 'property', name: 'Pacific Avenue',       group: 'green',     price: 300, houseCost: 200, rent: [26, 130, 390, 900, 1100, 1275] },
    { id: 32, type: 'property', name: 'North Carolina Avenue', group: 'green',    price: 300, houseCost: 200, rent: [26, 130, 390, 900, 1100, 1275] },
    { id: 33, type: 'chest',    name: 'Community Chest' },
    { id: 34, type: 'property', name: 'Pennsylvania Avenue',  group: 'green',     price: 320, houseCost: 200, rent: [28, 150, 450, 1000, 1200, 1400] },
    { id: 35, type: 'railroad', name: 'Short Line',           group: 'railroad',  price: 200 },
    { id: 36, type: 'chance',   name: 'Chance' },
    { id: 37, type: 'property', name: 'Park Place',           group: 'darkblue',  price: 350, houseCost: 200, rent: [35, 175, 500, 1100, 1300, 1500] },
    { id: 38, type: 'tax',      name: 'Luxury Tax',           amount: 100 },
    { id: 39, type: 'property', name: 'Boardwalk',            group: 'darkblue',  price: 400, houseCost: 200, rent: [50, 200, 600, 1400, 1700, 2000] }
];

/*
 * Balanced rents from ludible.nl "How I Fixed Monopoly" (Johan van der Beek):
 * every property gets the same hit-rate-weighted ROI. Used only when a game
 * is created with the Balanced rules toggle; prices and house costs stay
 * unchanged. Rules.rentTable() picks between this and tile.rent.
 *   property: [base, 1 house, 2, 3, 4, hotel]
 *   railroad: rent by railroads owned [1, 2, 3, 4]
 *   utility:  dice multiplier by utilities owned [1, 2]
 */
const BALANCED_RENTS = {
    1:  [3, 15, 55, 150, 205, 255],
    3:  [7, 35, 105, 285, 390, 490],
    5:  [25, 55, 110, 220],
    6:  [8, 40, 110, 280, 370, 455],
    8:  [8, 40, 110, 280, 370, 455],
    9:  [9, 45, 125, 315, 415, 505],
    11: [10, 60, 175, 470, 630, 790],
    12: [6, 16],
    13: [10, 60, 175, 470, 630, 790],
    14: [12, 70, 210, 555, 745, 930],
    15: [30, 55, 115, 225],
    16: [12, 65, 180, 470, 625, 770],
    18: [12, 65, 180, 470, 625, 770],
    19: [13, 65, 195, 505, 670, 825],
    21: [15, 85, 250, 665, 895, 1115],
    23: [15, 85, 250, 665, 895, 1115],
    24: [16, 90, 270, 715, 960, 1195],
    25: [25, 55, 110, 225],
    26: [20, 105, 305, 795, 1055, 1305],
    27: [20, 105, 305, 795, 1055, 1305],
    28: [7, 17],
    29: [21, 110, 320, 840, 1115, 1380],
    31: [23, 130, 385, 1015, 1365, 1705],
    32: [23, 130, 385, 1015, 1365, 1705],
    34: [26, 145, 425, 1125, 1510, 1885],
    35: [40, 80, 160, 325],
    37: [29, 110, 310, 805, 1065, 1315],
    39: [37, 140, 400, 1035, 1370, 1695]
};

/*
 * Card effect types (closed set handled by features/cards.js):
 *   moveTo, moveBy, moveToNearest, collect, pay, payEach, collectEach,
 *   repairs, goToJail, getOutOfJail
 */
const CHANCE_CARDS = [
    { id: 'ch1',  text: 'Advance to GO. Collect $200.',                                    effect: { type: 'moveTo', tile: 0 } },
    { id: 'ch2',  text: 'Advance to Illinois Avenue. If you pass GO, collect $200.',       effect: { type: 'moveTo', tile: 24 } },
    { id: 'ch3',  text: 'Advance to St. Charles Place. If you pass GO, collect $200.',     effect: { type: 'moveTo', tile: 11 } },
    { id: 'ch4',  text: 'Advance to the nearest Utility. If owned, pay 10 times a new dice roll.', effect: { type: 'moveToNearest', tileType: 'utility', special: 'tenTimesDice' } },
    { id: 'ch5',  text: 'Advance to the nearest Railroad. Pay the owner double rent.',     effect: { type: 'moveToNearest', tileType: 'railroad', special: 'doubleRent' } },
    { id: 'ch6',  text: 'Advance to the nearest Railroad. Pay the owner double rent.',     effect: { type: 'moveToNearest', tileType: 'railroad', special: 'doubleRent' } },
    { id: 'ch7',  text: 'Bank pays you a dividend of $50.',                                effect: { type: 'collect', amount: 50 } },
    { id: 'ch8',  text: 'Get Out of Jail Free. Keep this card until needed or traded.',    effect: { type: 'getOutOfJail' } },
    { id: 'ch9',  text: 'Go back 3 spaces.',                                               effect: { type: 'moveBy', amount: -3 } },
    { id: 'ch10', text: 'Go directly to Jail. Do not pass GO, do not collect $200.',       effect: { type: 'goToJail' } },
    { id: 'ch11', text: 'Make general repairs on all your property: $25 per house, $100 per hotel.', effect: { type: 'repairs', perHouse: 25, perHotel: 100 } },
    { id: 'ch12', text: 'Speeding fine. Pay $15.',                                         effect: { type: 'pay', amount: 15 } },
    { id: 'ch13', text: 'Take a trip to Reading Railroad. If you pass GO, collect $200.',  effect: { type: 'moveTo', tile: 5 } },
    { id: 'ch14', text: 'Take a walk on the Boardwalk. Advance to Boardwalk.',             effect: { type: 'moveTo', tile: 39 } },
    { id: 'ch15', text: 'You have been elected Chairman of the Board. Pay each player $50.', effect: { type: 'payEach', amount: 50 } },
    { id: 'ch16', text: 'Your building loan matures. Collect $150.',                       effect: { type: 'collect', amount: 150 } }
];

const COMMUNITY_CARDS = [
    { id: 'cc1',  text: 'Advance to GO. Collect $200.',                          effect: { type: 'moveTo', tile: 0 } },
    { id: 'cc2',  text: 'Bank error in your favor. Collect $200.',               effect: { type: 'collect', amount: 200 } },
    { id: 'cc3',  text: "Doctor's fee. Pay $50.",                                effect: { type: 'pay', amount: 50 } },
    { id: 'cc4',  text: 'From sale of stock you get $50.',                       effect: { type: 'collect', amount: 50 } },
    { id: 'cc5',  text: 'Get Out of Jail Free. Keep this card until needed or traded.', effect: { type: 'getOutOfJail' } },
    { id: 'cc6',  text: 'Go directly to Jail. Do not pass GO, do not collect $200.', effect: { type: 'goToJail' } },
    { id: 'cc7',  text: 'Holiday fund matures. Collect $100.',                   effect: { type: 'collect', amount: 100 } },
    { id: 'cc8',  text: 'Income tax refund. Collect $20.',                       effect: { type: 'collect', amount: 20 } },
    { id: 'cc9',  text: 'It is your birthday. Collect $10 from every player.',   effect: { type: 'collectEach', amount: 10 } },
    { id: 'cc10', text: 'Life insurance matures. Collect $100.',                 effect: { type: 'collect', amount: 100 } },
    { id: 'cc11', text: 'Pay hospital fees of $100.',                            effect: { type: 'pay', amount: 100 } },
    { id: 'cc12', text: 'Pay school fees of $50.',                               effect: { type: 'pay', amount: 50 } },
    { id: 'cc13', text: 'Receive $25 consultancy fee.',                          effect: { type: 'collect', amount: 25 } },
    { id: 'cc14', text: 'You are assessed for street repairs: $40 per house, $115 per hotel.', effect: { type: 'repairs', perHouse: 40, perHotel: 115 } },
    { id: 'cc15', text: 'You have won second prize in a beauty contest. Collect $10.', effect: { type: 'collect', amount: 10 } },
    { id: 'cc16', text: 'You inherit $100.',                                     effect: { type: 'collect', amount: 100 } }
];

/*
 * Approximate steady-state landing probabilities (%), used only to weight
 * AI property valuation. Jail-orbit tiles (orange/red) land more often.
 */
const LANDING_FREQ = [
    3.1, 2.1, 1.9, 2.2, 2.3, 3.0, 2.3, 0.9, 2.3, 2.3,
    3.9, 2.7, 2.6, 2.4, 2.5, 2.9, 2.8, 2.6, 2.9, 3.1,
    2.9, 2.8, 1.0, 2.7, 3.2, 3.1, 2.7, 2.7, 2.8, 2.6,
    0.0, 2.7, 2.6, 2.4, 2.5, 2.4, 0.9, 2.2, 2.2, 2.6
];

/**
 * 11x11 CSS grid placement for the ring board.
 * Returns { row, col }, both 1-based.
 */
function tileGridPos(id) {
    if (id <= 10) return { row: 11, col: 11 - id };          // bottom edge, GO at right
    if (id <= 20) return { row: 11 - (id - 10), col: 1 };    // left edge going up
    if (id <= 30) return { row: 1, col: id - 19 };           // top edge going right
    return { row: id - 29, col: 11 };                        // right edge going down
}

if (typeof window !== 'undefined') {
    window.BOARD = BOARD;
    window.BALANCED_RENTS = BALANCED_RENTS;
    window.CHANCE_CARDS = CHANCE_CARDS;
    window.COMMUNITY_CARDS = COMMUNITY_CARDS;
    window.LANDING_FREQ = LANDING_FREQ;
    window.tileGridPos = tileGridPos;
}
