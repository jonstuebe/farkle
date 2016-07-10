import Reflux from 'reflux';

const Actions = Reflux.createActions([
    'createGame',
]);

Actions.createGame.listen(() => {

    console.log('createGame action fired');

});

export default Actions;
