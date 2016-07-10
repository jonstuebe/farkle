import Reflux from 'reflux';

const PlayersActions = Reflux.createActions([
    'addPlayer',
    'removePlayer',
    'editPlayer',
]);

PlayersActions.addPlayer.listen(() => {

    console.log('addPlayer action fired');

});

PlayersActions.removePlayer.listen(() => {

    console.log('removePlayer action fired');

});

PlayersActions.editPlayer.listen(() => {

    console.log('editPlayer action fired');

});

export default PlayersActions;
