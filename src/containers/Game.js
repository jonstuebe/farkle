import React from 'react';
import { Link } from 'react-router';

import TitleBar from '../components/TitleBar';
import ListItems from '../components/ListItems';
import ListItem from '../components/ListItem';
import BottomDrawer from '../components/BottomDrawer';

const Game = React.createClass({
    render(){

        const id = location.pathname.slice(1).split('/')[1];

        return (
            <div>
                <TitleBar title="Game" back={"/games"} />
                <ListItems>
                    <ListItem title={"Jon"} details={"5,250"} active={true} />
                    <ListItem title={"Kevin"} details={"3,000"} />
                    <ListItem title={"Kay"} details={"4,500"} />
                </ListItems>
                <BottomDrawer>
                    <Link to={ location.pathname + "start/" } className="button">play turn</Link>
                </BottomDrawer>
            </div>
        )
    }
});

export default Game;
