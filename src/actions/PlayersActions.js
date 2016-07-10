import Reflux from 'reflux';

const PlayersActions = Reflux.createActions([
    'addPlayer',
    'removePlayer',
    'editPlayer',
    'playTurn',
    'removeAll',
]);

export default PlayersActions;
